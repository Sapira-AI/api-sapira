import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PENDIENTE DE COMMIT (se revisa después de aplicar 1790620000000 y 1790630000000). Al commitear esta migración hay que re-agregar
 * en el working tree lo que se retiró para que el set "tax + pricing" quedara autocontenido:
 *
 * - `entities/contratos/price.entity.ts`: `'quote'` en `PRICE_OWNERS`; columna `quote_id` (uuid, nullable, comment Cotizaciones v2);
 *   `@Index('idx_prices_quote_id', ['quote_id'], { where: "owner = 'quote'" })`; `@ManyToOne(() => Quote, { onDelete: 'CASCADE' })`
 *   + `@JoinColumn({ name: 'quote_id', foreignKeyConstraintName: 'prices_quote_id_fkey' })` con su import de `quote.entity`;
 *   y los CHECK con la forma nueva: `prices_owner_check` = owner IN (catalog, contract, quote) y `prices_contract_owner_check` =
 *   (contract ∧ contract_id NOT NULL ∧ quote_id NULL) ∨ (catalog ∧ ambos NULL) ∨ (quote ∧ quote_id NOT NULL ∧ contract_id NULL).
 * - `entities/contratos/pricing-v2.entity.spec.ts`: asertar `quote_id`, `prices_quote_id_fkey` e `idx_prices_quote_id` (hay un comentario
 *   junto al test de `prices` con los valores exactos).
 * - Inventarios: `quote_events`/`QuoteEvent` en `entities/espejo.existing.ts`, `scripts/espejo/existing-entities.json`,
 *   `scripts/espejo/module-map.json` (grupo cotizaciones-catalogo) y sumar el trigger `quotes_set_updated_at` (+1) y la policy
 *   `rls/holding_access_quote_events.sql` (+1) en la tabla de fases de `src/databases/postgresql/README.md`.
 * - Renombrar `entities/cotizaciones-catalogo/quote-event.entity.ts.pending` → `quote-event.entity.ts` (se renombró porque el glob de
 *   entities lo cargaba y los guards de `database.module.spec.ts` exigen que toda entity en disco esté inventariada).
 *
 * Cotizaciones v2 (`docs/v2-rediseno/mapa-v2-cotizaciones.md` §8). Esquema **aditivo**: nada se renombra ni se borra.
 *
 * 1. `quote_stages.kind` (draft | sent | signed | lost | contract_created, CHECK) + UNIQUE parcial (holding, kind) para `signed` y
 *    `lost` (`quote-stage.entity.ts`). `contract_created` admite varias etapas por holding (decisión Domi 29-09: SimpliRoute tiene
 *    "Contrato creado" y "Procesada previamente" y las dos son contrato creado; el estado se deriva por kind, no por etapa).
 * 2. `quotes`: `valid_until` (Q-A2), `deleted_at` (Q-A5) y `updated_at` (trigger `quotes_set_updated_at`, asset) con sus índices
 *    parciales (`quote.entity.ts`). **Nada que duplique o se derive de datos existentes** (regla de Domi): la línea de vida
 *    (`sent_at`, `lost_at`, `lost_reason`, quién creó/editó) sale de `quote_events`; `signed_at` es `booking_date` en las firmadas;
 *    la condición de pago estructurada (Q-D4) se deriva del texto canónico de `payment_terms` (`parsePaymentTermsText`).
 *    Sin `company_id` (Q-A4 decidido: no; la compañía emisora se elige solo al crear el contrato).
 * 3. `quote_items.price_id` → `prices` (Q-A3); `prices.owner` suma `quote` y `prices.quote_id` (FK CASCADE): los dos CHECK de `prices`
 *    se recrean con la forma nueva (`price.entity.ts`). Única transición sobre objetos existentes.
 * 4. `quote_events` (historial, §5a) con RLS activado a mano; la policy es un asset (`rls/holding_access_quote_events.sql`).
 * 5. **Datos** (corregir/transformar datos = migración, GUIA): backfill de `kind` por nombre (`contrato creado` y `procesada/procesado
 *    previamente` → contract_created [Domi 29-09: cotizaciones procesadas en el flujo anterior fuera de Sapira; el contrato nació con esa
 *    cotización], `%firmad%` → signed, `%perdid%`/`%rechaz%` → lost, `%enviad%` → sent, resto → draft; si un holding tiene dos etapas que
 *    calzan `signed` o `lost`, solo la primera por posición lo recibe y las demás quedan draft, para que el UNIQUE se pueda crear).
 *    **No** se crea la etapa "Contrato creado" en los holdings que no la tienen (decisión Domi 29-09: Hanka sigue sin ella; sus firmadas
 *    con contrato se muestran "Contrato creado" por el vínculo, y `markQuoteContractCreated` deja la cotización donde está con aviso en el
 *    evento). Sin backfill de fechas: no hay columnas de línea de vida.
 *    `quote_number` NO recibe UNIQUE todavía: antes se resuelven los duplicados de prod (mapa §8, lo revisa Domi); la API lo garantiza
 *    con lock por holding. `quote_type` no se reescribe: la API normaliza al leer y escribe el código en las nuevas (Q-A9).
 *
 * Escrita a mano con la forma que emite `migration:generate` (recortada). Orden de despliegue: 1) `1790630000000-CreatePricingV2`
 * (crea `prices`), 2) esta migración, 3) `postgres:assets --only rls/holding_access_quote_events.sql --only triggers/quotes_set_updated_at.sql
 * --only functions/create_default_quote_stages_for_holding.sql`, 4) el código (`src/modules/quotes` lee `kind`, `deleted_at` y
 * `quote_events`; `contract-drafts.service.ts` busca la etapa por `kind` antes que por nombre).
 */
export class QuotesV21790650000000 implements MigrationInterface {
	name = 'QuotesV21790650000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. quote_stages.kind
		await queryRunner.query(`ALTER TABLE "quote_stages" ADD "kind" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "quote_stages"."kind" IS 'v2 (Q-A1): kind de sistema draft | sent | signed | lost | contract_created. NULL cuenta como draft. Backfill por nombre en la migración QuotesV2'`
		);
		await queryRunner.query(
			`ALTER TABLE "quote_stages" ADD CONSTRAINT "quote_stages_kind_check" CHECK ((kind IS NULL) OR (kind = ANY (ARRAY['draft'::text, 'sent'::text, 'signed'::text, 'lost'::text, 'contract_created'::text])))`
		);

		// 5. Backfill de kind por nombre. signed/lost: solo la primera etapa por posición de cada (holding, kind); el resto queda draft.
		// contract_created admite varias etapas por holding ("Contrato creado" y "Procesada previamente" en SimpliRoute).
		await queryRunner.query(`
			WITH mapped AS (
				SELECT id, holding_id, position,
					CASE
						WHEN lower(name) LIKE '%contrato creado%' THEN 'contract_created'
						WHEN lower(name) LIKE '%procesada previamente%' OR lower(name) LIKE '%procesado previamente%' THEN 'contract_created'
						WHEN lower(name) LIKE '%firmad%' THEN 'signed'
						WHEN lower(name) LIKE '%perdid%' OR lower(name) LIKE '%rechaz%' THEN 'lost'
						WHEN lower(name) LIKE '%enviad%' THEN 'sent'
						ELSE 'draft'
					END AS kind
				FROM quote_stages
			),
			ranked AS (
				SELECT id, kind, ROW_NUMBER() OVER (PARTITION BY holding_id, kind ORDER BY position, id) AS rn FROM mapped
			)
			UPDATE quote_stages qs
			SET kind = CASE WHEN r.kind IN ('signed', 'lost') AND r.rn > 1 THEN 'draft' ELSE r.kind END
			FROM ranked r
			WHERE r.id = qs.id
		`);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "idx_quote_stages_holding_kind_unique" ON "quote_stages" ("holding_id", "kind") WHERE (kind = ANY (ARRAY['signed'::text, 'lost'::text]))`
		);

		// 2. quotes
		await queryRunner.query(`ALTER TABLE "quotes" ADD "valid_until" date`);
		await queryRunner.query(
			`COMMENT ON COLUMN "quotes"."valid_until" IS 'v2 (Q-A2): válida hasta; NULL = sin vencimiento. Estado mostrado "Vencida" si kind draft/sent y < hoy'`
		);
		await queryRunner.query(`ALTER TABLE "quotes" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`COMMENT ON COLUMN "quotes"."deleted_at" IS 'v2 (Q-A5): borrado lógico. El sync de Salesforce ignora las borradas'`);
		await queryRunner.query(`ALTER TABLE "quotes" ADD "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now()`);
		await queryRunner.query(`COMMENT ON COLUMN "quotes"."updated_at" IS 'v2: trigger quotes_set_updated_at'`);
		await queryRunner.query(`CREATE INDEX "idx_quotes_holding_active" ON "quotes" ("holding_id") WHERE (deleted_at IS NULL)`);
		await queryRunner.query(`CREATE INDEX "idx_quotes_valid_until" ON "quotes" ("valid_until") WHERE (valid_until IS NOT NULL)`);

		// 3. prices.owner = quote + prices.quote_id; quote_items.price_id
		await queryRunner.query(`ALTER TABLE "prices" ADD "quote_id" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."quote_id" IS 'Cotizaciones v2: NOT NULL si owner = quote (precio inline del ítem de cotización), NULL si no (CHECK)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."owner" IS 'catalog, contract o quote. Etapa 1 escribe contract (precio inline del ítem); Cotizaciones v2 escribe quote'`
		);
		await queryRunner.query(`CREATE INDEX "idx_prices_quote_id" ON "prices" ("quote_id") WHERE owner = 'quote'`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "prices" DROP CONSTRAINT "prices_owner_check"`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_owner_check" CHECK ("owner" = ANY (ARRAY['catalog'::text, 'contract'::text, 'quote'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "prices" DROP CONSTRAINT "prices_contract_owner_check"`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_contract_owner_check" CHECK (("owner" = 'contract' AND "contract_id" IS NOT NULL AND "quote_id" IS NULL) OR ("owner" = 'catalog' AND "contract_id" IS NULL AND "quote_id" IS NULL) OR ("owner" = 'quote' AND "quote_id" IS NOT NULL AND "contract_id" IS NULL))`
		);
		await queryRunner.query(`ALTER TABLE "quote_items" ADD "price_id" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "quote_items"."price_id" IS 'Pricing v2: modelo de precio del ítem (prices). NULL = standard fijo'`
		);
		await queryRunner.query(`CREATE INDEX "idx_quote_items_price_id" ON "quote_items" ("price_id") WHERE (price_id IS NOT NULL)`);
		await queryRunner.query(
			`ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "prices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);

		// 4. quote_events
		await queryRunner.query(
			`CREATE TABLE "quote_events" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"quote_id" uuid NOT NULL,
				"type" text NOT NULL,
				"from_stage_id" uuid,
				"to_stage_id" uuid,
				"from_kind" text,
				"to_kind" text,
				"actor_id" uuid,
				"reason" text,
				"metadata" jsonb NOT NULL DEFAULT '{}',
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "quote_events_type_check" CHECK ("type" = ANY (ARRAY['CREATED'::text, 'UPDATED'::text, 'SENT'::text, 'SIGNED'::text, 'LOST'::text, 'REOPENED'::text, 'STAGE_CHANGED'::text, 'DUPLICATED_FROM'::text, 'CONTRACT_CREATED'::text, 'APPLIED_TO_CONTRACT'::text, 'DELETED'::text])),
				CONSTRAINT "quote_events_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "quote_events" IS 'Historial de la cotización: creación, edición, transiciones, duplicado, contrato y borrado'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "quote_events"."type" IS 'CREATED, UPDATED, SENT, SIGNED, LOST, REOPENED, STAGE_CHANGED, DUPLICATED_FROM, CONTRACT_CREATED, APPLIED_TO_CONTRACT o DELETED'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."from_stage_id" IS 'Etapa antes (NULL al crear)'`);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."to_stage_id" IS 'Etapa después (NULL al borrar)'`);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."from_kind" IS 'kind de la etapa antes'`);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."to_kind" IS 'kind de la etapa después'`);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."actor_id" IS 'users.id que ejecutó la acción (NULL si lo hizo un proceso)'`);
		await queryRunner.query(`COMMENT ON COLUMN "quote_events"."reason" IS 'Motivo (obligatorio al marcar perdida)'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "quote_events"."metadata" IS 'Antes/después, ítems tocados, contrato vinculado, número de cotización…'`
		);
		await queryRunner.query(`CREATE INDEX "idx_quote_events_quote_id" ON "quote_events" ("quote_id")`);
		await queryRunner.query(`CREATE INDEX "idx_quote_events_holding_id" ON "quote_events" ("holding_id")`);
		await queryRunner.query(
			`ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "quote_stages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "quote_stages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "quote_events" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE "quote_events"`);
		await queryRunner.query(`ALTER TABLE "quote_items" DROP CONSTRAINT "quote_items_price_id_fkey"`);
		await queryRunner.query(`DROP INDEX "public"."idx_quote_items_price_id"`);
		await queryRunner.query(`ALTER TABLE "quote_items" DROP COLUMN "price_id"`);
		// Los precios de cotización se borran con el revert: sin owner = quote no pueden existir.
		await queryRunner.query(`DELETE FROM "prices" WHERE "owner" = 'quote'`);
		await queryRunner.query(`ALTER TABLE "prices" DROP CONSTRAINT "prices_contract_owner_check"`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_contract_owner_check" CHECK (("owner" = 'contract' AND "contract_id" IS NOT NULL) OR ("owner" = 'catalog' AND "contract_id" IS NULL))`
		);
		await queryRunner.query(`ALTER TABLE "prices" DROP CONSTRAINT "prices_owner_check"`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_owner_check" CHECK ("owner" = ANY (ARRAY['catalog'::text, 'contract'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "prices" DROP CONSTRAINT "prices_quote_id_fkey"`);
		await queryRunner.query(`DROP INDEX "public"."idx_prices_quote_id"`);
		await queryRunner.query(`ALTER TABLE "prices" DROP COLUMN "quote_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_quotes_valid_until"`);
		await queryRunner.query(`DROP INDEX "public"."idx_quotes_holding_active"`);
		for (const column of ['updated_at', 'deleted_at', 'valid_until']) {
			await queryRunner.query(`ALTER TABLE "quotes" DROP COLUMN "${column}"`);
		}
		await queryRunner.query(`DROP INDEX "public"."idx_quote_stages_holding_kind_unique"`);
		await queryRunner.query(`ALTER TABLE "quote_stages" DROP CONSTRAINT "quote_stages_kind_check"`);
		await queryRunner.query(`ALTER TABLE "quote_stages" DROP COLUMN "kind"`);
	}
}

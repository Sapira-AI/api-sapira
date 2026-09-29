import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pricing v2 · etapas 1 y 2 (`docs/v2-rediseno/spec-pricing-v2.md` §2). Esquema **aditivo**: nada se renombra ni se borra.
 *
 * 1. `billable_metrics`: qué se mide y cómo se agrega, por holding (`entities/contratos/billable-metric.entity.ts`).
 * 2. `prices`: el modelo de precio (catálogo o contrato) con tramos, gratis, mínimo y tope (`price.entity.ts`).
 * 3. `consumption_entries`: consumo vigente de un ítem por período de servicio, una fila por ítem y período
 *    (`consumption-entry.entity.ts`); `consumption_entry_revisions`: historial append-only de cada corrección
 *    (`consumption-entry-revision.entity.ts`).
 *    `consumption_entries.invoice_id` apunta a la factura que lleva el consumo (Por Emitir recalculada, complementaria o
 *    reemitida, spec §4.4). `prices.invoice_line_mode` (single | per_tier, §3.8) y `prices.charge_flat_when_free` (§3.5).
 * 4. `contract_items.price_id` (FK a `prices`, NULL = standard fijo de hoy), `invoice_items.pricing_breakdown` (sublíneas del
 *    motor) y `invoice_items.quantity_source` (fixed | consumption | estimated | pending).
 * 5. `invoice_items_quantity_check` pasa de `quantity > 0` a `quantity >= 0`: un consumo 0 deja la línea en 0 (spec §2.3);
 *    con el CHECK anterior esa línea no se podía guardar. Es la única transición sobre un objeto existente.
 *
 * Escrita a mano con la forma que emite `migration:generate` para estas entities (recortada). RLS de las tablas nuevas
 * activado a mano: TypeORM no lo modela; las policies son assets (`rls/holding_access_billable_metrics.sql`,
 * `rls/holding_access_prices.sql`, `rls/holding_access_consumption_entries.sql`,
 * `rls/holding_access_consumption_entry_revisions.sql`), espejo de `holding_access_contract_items`.
 *
 * Orden de despliegue: 1) migración `1790620000000-CreateTaxDocumentTypes` (anterior), 2) esta migración, 3)
 * `postgres:assets --only rls/holding_access_billable_metrics.sql --only rls/holding_access_prices.sql
 * --only rls/holding_access_consumption_entries.sql --only rls/holding_access_consumption_entry_revisions.sql`, 4) el código
 * (la activación escribe `pricing_breakdown`/`quantity_source` y el alta lee `billable_metrics`/`prices`: sin la migración
 * fallan). Ningún trigger nuevo: la lógica vive en la API (`SET LOCAL sapira.writer = 'api'`, costura del mapa §1.3).
 */
export class CreatePricingV21790630000000 implements MigrationInterface {
	name = 'CreatePricingV21790630000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. billable_metrics
		await queryRunner.query(
			`CREATE TABLE "billable_metrics" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"code" text NOT NULL,
				"name" text NOT NULL,
				"description" text,
				"aggregation" text NOT NULL,
				"unit" text NOT NULL,
				"source_kind" text NOT NULL DEFAULT 'manual',
				"source_config" jsonb NOT NULL DEFAULT '{}',
				"status" text NOT NULL DEFAULT 'active',
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"created_by" uuid,
				"updated_by" uuid,
				"archived_at" TIMESTAMP WITH TIME ZONE,
				CONSTRAINT "billable_metrics_holding_id_code_key" UNIQUE ("holding_id", "code"),
				CONSTRAINT "billable_metrics_aggregation_check" CHECK ("aggregation" = ANY (ARRAY['sum'::text, 'count'::text, 'max'::text, 'min'::text, 'last'::text, 'unique_count'::text])),
				CONSTRAINT "billable_metrics_source_kind_check" CHECK ("source_kind" = ANY (ARRAY['manual'::text, 'csv'::text, 'dwh'::text, 'api'::text])),
				CONSTRAINT "billable_metrics_status_check" CHECK ("status" = ANY (ARRAY['active'::text, 'archived'::text])),
				CONSTRAINT "billable_metrics_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "billable_metrics" IS 'Métricas facturables por holding: qué se mide (rutas, usuarios, GB), cómo se agrega y de dónde llega'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "billable_metrics"."code" IS 'Slug estable para API y DWH, único por holding'`);
		await queryRunner.query(`COMMENT ON COLUMN "billable_metrics"."name" IS 'Lo que ve la usuaria ("Rutas completadas")'`);
		await queryRunner.query(`COMMENT ON COLUMN "billable_metrics"."aggregation" IS 'sum, count, max, min, last o unique_count'`);
		await queryRunner.query(`COMMENT ON COLUMN "billable_metrics"."unit" IS 'Unidad en singular para glosa y UI ("ruta", "usuario", "GB")'`);
		await queryRunner.query(`COMMENT ON COLUMN "billable_metrics"."source_kind" IS 'manual, csv, dwh o api'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "billable_metrics"."source_config" IS 'Para dwh: referencia a la consulta/tabla de BigQuery; para el resto {}'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "billable_metrics"."status" IS 'active o archived; una métrica con precios activos no se archiva'`
		);
		await queryRunner.query(`CREATE INDEX "idx_billable_metrics_holding_status" ON "billable_metrics" ("holding_id", "status")`);
		await queryRunner.query(
			`ALTER TABLE "billable_metrics" ADD CONSTRAINT "billable_metrics_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "billable_metrics" ADD CONSTRAINT "billable_metrics_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "billable_metrics" ADD CONSTRAINT "billable_metrics_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		// Tabla nueva: RLS a mano (los assets de rls/ solo declaran policies).
		await queryRunner.query(`ALTER TABLE "billable_metrics" ENABLE ROW LEVEL SECURITY`);

		// 2. prices
		await queryRunner.query(
			`CREATE TABLE "prices" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"owner" text NOT NULL,
				"product_id" uuid NOT NULL,
				"contract_id" uuid,
				"name" text NOT NULL,
				"currency" text NOT NULL,
				"model" text NOT NULL,
				"quantity_type" text NOT NULL,
				"billable_metric_id" uuid,
				"unit_amount" numeric(18,6),
				"tiers" jsonb,
				"package_size" numeric(18,6),
				"package_amount" numeric(18,2),
				"seat_minimum_quantity" numeric(18,6) DEFAULT '0',
				"free_units" numeric(18,6) DEFAULT '0',
				"minimum_amount" numeric(18,2),
				"cap_amount" numeric(18,2),
				"invoice_line_mode" text NOT NULL DEFAULT 'single',
				"charge_flat_when_free" boolean NOT NULL DEFAULT false,
				"status" text NOT NULL DEFAULT 'active',
				"version" integer NOT NULL DEFAULT '1',
				"supersedes_price_id" uuid,
				"list_price_id" uuid,
				"notes" text,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"created_by" uuid,
				"updated_by" uuid,
				"published_at" TIMESTAMP WITH TIME ZONE,
				"archived_at" TIMESTAMP WITH TIME ZONE,
				CONSTRAINT "prices_owner_check" CHECK ("owner" = ANY (ARRAY['catalog'::text, 'contract'::text])),
				CONSTRAINT "prices_model_check" CHECK ("model" = ANY (ARRAY['standard'::text, 'graduated'::text, 'volume'::text, 'package'::text, 'seat'::text])),
				CONSTRAINT "prices_quantity_type_check" CHECK ("quantity_type" = ANY (ARRAY['fixed'::text, 'metered'::text])),
				CONSTRAINT "prices_status_check" CHECK ("status" = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])),
				CONSTRAINT "prices_contract_owner_check" CHECK (("owner" = 'contract' AND "contract_id" IS NOT NULL) OR ("owner" = 'catalog' AND "contract_id" IS NULL)),
				CONSTRAINT "prices_metered_metric_check" CHECK ("quantity_type" = 'fixed' OR "billable_metric_id" IS NOT NULL),
				CONSTRAINT "prices_cap_minimum_check" CHECK ("cap_amount" IS NULL OR "minimum_amount" IS NULL OR "cap_amount" >= "minimum_amount"),
				CONSTRAINT "prices_invoice_line_mode_check" CHECK ("invoice_line_mode" = ANY (ARRAY['single'::text, 'per_tier'::text])),
				CONSTRAINT "prices_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "prices" IS 'Modelo de precio (standard, graduated, volume, package, seat) con cantidad fija o medida, tramos, gratis, mínimo y tope'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."owner" IS 'catalog (versionado, etapa 3) o contract (precio inline del ítem o copia del catálogo)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."product_id" IS 'El ítem exige producto (S1-12)'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."contract_id" IS 'NOT NULL si owner = contract, NULL si catalog (CHECK)'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."name" IS 'Etiqueta ("Tramos LatAm — UF"); para contract default = nombre del producto'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."currency" IS 'Moneda del contrato (S1-2); en catálogo, la del precio'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."model" IS 'standard, graduated, volume, package o seat'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."quantity_type" IS 'fixed o metered; metered exige billable_metric_id'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."unit_amount" IS 'standard y seat: precio por unidad del período (no mensual)'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."tiers" IS 'graduated/volume: [{from, to, per_unit_amount, flat_amount}]'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."package_size" IS 'package: bloque de N unidades'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."package_amount" IS 'package: precio del bloque'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."seat_minimum_quantity" IS 'seat: asientos mínimos cobrados'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."free_units" IS 'Unidades gratis por período'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."minimum_amount" IS 'Mínimo comprometido por período con true-up; NULL = sin mínimo'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."cap_amount" IS 'Tope máximo por período; NULL = sin tope'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."invoice_line_mode" IS 'Presentación en la factura (spec §3.8): single = una línea con el detalle en la glosa; per_tier = una línea por tramo más ajustes'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."charge_flat_when_free" IS 'graduated/volume: cobrar el cargo fijo del tramo aunque todo el consumo caiga en unidades gratis (spec §3.5, pregunta 5)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."status" IS 'draft, active o archived; contract nace active'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."version" IS 'Sube con cada supersedes_price_id'`);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."supersedes_price_id" IS 'Versión anterior'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "prices"."list_price_id" IS 'En owner = contract, el precio de catálogo del que salió (etapa 3). NULL en precios inline'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "prices"."notes" IS 'Catálogo: nota interna de la versión (qué cambió, para quién aplica)'`);
		await queryRunner.query(`CREATE INDEX "idx_prices_holding_product_status" ON "prices" ("holding_id", "product_id", "status")`);
		await queryRunner.query(`CREATE INDEX "idx_prices_contract_id" ON "prices" ("contract_id") WHERE owner = 'contract'`);
		await queryRunner.query(`CREATE INDEX "idx_prices_billable_metric_id" ON "prices" ("billable_metric_id")`);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_billable_metric_id_fkey" FOREIGN KEY ("billable_metric_id") REFERENCES "billable_metrics"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_supersedes_price_id_fkey" FOREIGN KEY ("supersedes_price_id") REFERENCES "prices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_list_price_id_fkey" FOREIGN KEY ("list_price_id") REFERENCES "prices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "prices" ADD CONSTRAINT "prices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "prices" ENABLE ROW LEVEL SECURITY`);

		// 3. consumption_entries + consumption_entry_revisions
		await queryRunner.query(
			`CREATE TABLE "consumption_entries" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"contract_id" uuid NOT NULL,
				"contract_item_id" uuid NOT NULL,
				"period_start" date NOT NULL,
				"period_end" date NOT NULL,
				"quantity" numeric(18,6) NOT NULL,
				"amount_override" numeric(18,2),
				"apply_item_discount" boolean NOT NULL DEFAULT true,
				"account" text,
				"is_estimated" boolean NOT NULL DEFAULT false,
				"source" text NOT NULL DEFAULT 'manual',
				"idempotency_key" text,
				"revision" integer NOT NULL DEFAULT '1',
				"correction_reason" text,
				"notes" text,
				"invoice_id" uuid,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"created_by" uuid,
				"updated_by" uuid,
				CONSTRAINT "consumption_entries_contract_item_id_period_start_key" UNIQUE ("contract_item_id", "period_start"),
				CONSTRAINT "consumption_entries_quantity_check" CHECK ("quantity" >= 0),
				CONSTRAINT "consumption_entries_period_check" CHECK ("period_end" >= "period_start"),
				CONSTRAINT "consumption_entries_source_check" CHECK ("source" = ANY (ARRAY['manual'::text, 'csv'::text, 'dwh'::text, 'api'::text])),
				CONSTRAINT "consumption_entries_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "consumption_entries" IS 'Consumo vigente de un ítem por período de servicio (reemplaza quantities en Contratos v2); las correcciones quedan en consumption_entry_revisions'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."period_start" IS 'Inicio del período de servicio de la línea que alimenta (= invoice_items.billing_period_start)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."period_end" IS 'Fin del período de servicio de la línea (= invoice_items.billing_period_end)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."quantity" IS '0 = sin consumo: la línea queda en 0 (nunca cobra la cantidad base)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."amount_override" IS 'Monto final informado por el cliente; si viene, la línea usa este monto y quantity queda informativa'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."apply_item_discount" IS 'El descuento del ítem se aplica sobre el consumo (S7-9)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "consumption_entries"."account" IS 'Cuenta del período si difiere de la del ítem'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."is_estimated" IS 'true = fila estimada al cierre; se reemplaza al llegar el real'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "consumption_entries"."source" IS 'manual, csv, dwh o api'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."idempotency_key" IS 'El DWH y la API reenvían sin duplicar (único por holding)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "consumption_entries"."revision" IS 'Sube en cada corrección'`);
		await queryRunner.query(`COMMENT ON COLUMN "consumption_entries"."correction_reason" IS 'Motivo obligatorio desde la revisión 2'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entries"."invoice_id" IS 'Factura que lleva este consumo: la Por Emitir recalculada, la complementaria (consumo adicional) o la reemitida (spec §4.4). NULL si el período solo tenía facturas anuladas'`
		);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "idx_consumption_entries_idempotency" ON "consumption_entries" ("holding_id", "idempotency_key") WHERE idempotency_key IS NOT NULL`
		);
		await queryRunner.query(`CREATE INDEX "idx_consumption_entries_contract_period" ON "consumption_entries" ("contract_id", "period_start")`);
		await queryRunner.query(`CREATE INDEX "idx_consumption_entries_holding_id" ON "consumption_entries" ("holding_id")`);
		await queryRunner.query(
			`CREATE INDEX "idx_consumption_entries_invoice_id" ON "consumption_entries" ("invoice_id") WHERE invoice_id IS NOT NULL`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entries" ADD CONSTRAINT "consumption_entries_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "consumption_entries" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(
			`CREATE TABLE "consumption_entry_revisions" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"entry_id" uuid NOT NULL,
				"revision" integer NOT NULL,
				"quantity" numeric(18,6) NOT NULL,
				"amount_override" numeric(18,2),
				"apply_item_discount" boolean NOT NULL DEFAULT true,
				"source" text NOT NULL,
				"reason" text,
				"changed_by" uuid,
				"changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "consumption_entry_revisions_entry_id_revision_key" UNIQUE ("entry_id", "revision"),
				CONSTRAINT "consumption_entry_revisions_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "consumption_entry_revisions" IS 'Historial append-only de consumption_entries: una fila por revisión (nunca update destructivo sin rastro)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "consumption_entry_revisions"."reason" IS 'Motivo de la corrección (obligatorio desde la revisión 2)'`
		);
		await queryRunner.query(`CREATE INDEX "idx_consumption_entry_revisions_holding_id" ON "consumption_entry_revisions" ("holding_id")`);
		await queryRunner.query(
			`ALTER TABLE "consumption_entry_revisions" ADD CONSTRAINT "consumption_entry_revisions_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entry_revisions" ADD CONSTRAINT "consumption_entry_revisions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "consumption_entries"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "consumption_entry_revisions" ADD CONSTRAINT "consumption_entry_revisions_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "consumption_entry_revisions" ENABLE ROW LEVEL SECURITY`);

		// 4. contract_items.price_id
		await queryRunner.query(`ALTER TABLE "contract_items" ADD "price_id" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_items"."price_id" IS 'Pricing v2: modelo de precio del ítem (prices). NULL = standard fijo (unit_price mensual × cantidad × meses)'`
		);
		await queryRunner.query(`CREATE INDEX "idx_contract_items_price_id" ON "contract_items" ("price_id")`);
		await queryRunner.query(
			`ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "prices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);

		// 4. invoice_items.pricing_breakdown + quantity_source
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD "pricing_breakdown" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."pricing_breakdown" IS 'Pricing v2: sublíneas del desglose {kind: free|tier|package|seat|discount|minimum|cap, quantity, amount, label…} tal como las produjo el motor; la línea sigue siendo una'`
		);
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD "quantity_source" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."quantity_source" IS 'Pricing v2: fixed | consumption | estimated | pending (pending = línea metered sin consumo informado)'`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_source_check" CHECK ((("quantity_source" IS NULL) OR ("quantity_source" = ANY (ARRAY['fixed'::text, 'consumption'::text, 'estimated'::text, 'pending'::text]))))`
		);

		// 5. Una línea por consumo puede quedar en 0 (spec §2.3): el CHECK deja de exigir > 0.
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_check"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_check" CHECK ((quantity >= (0)::numeric))`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// El CHECK vuelve a > 0 solo si ninguna línea quedó en 0 (si la hay, el ALTER falla y el revert se detiene a propósito).
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_check"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_check" CHECK ((quantity > (0)::numeric))`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_source_check"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP COLUMN "quantity_source"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP COLUMN "pricing_breakdown"`);
		await queryRunner.query(`ALTER TABLE "contract_items" DROP CONSTRAINT "contract_items_price_id_fkey"`);
		await queryRunner.query(`DROP INDEX "public"."idx_contract_items_price_id"`);
		await queryRunner.query(`ALTER TABLE "contract_items" DROP COLUMN "price_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_consumption_entry_revisions_holding_id"`);
		await queryRunner.query(`DROP TABLE "consumption_entry_revisions"`);
		await queryRunner.query(`DROP INDEX "public"."idx_consumption_entries_invoice_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_consumption_entries_holding_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_consumption_entries_contract_period"`);
		await queryRunner.query(`DROP INDEX "public"."idx_consumption_entries_idempotency"`);
		await queryRunner.query(`DROP TABLE "consumption_entries"`);
		await queryRunner.query(`DROP INDEX "public"."idx_prices_billable_metric_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_prices_contract_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_prices_holding_product_status"`);
		await queryRunner.query(`DROP TABLE "prices"`);
		await queryRunner.query(`DROP INDEX "public"."idx_billable_metrics_holding_status"`);
		await queryRunner.query(`DROP TABLE "billable_metrics"`);
	}
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bloque Modificaciones B2 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §9.4 #1–#5, decisiones de Domi 01-10). Esquema
 * **aditivo**: dos tablas nuevas, dos columnas nuevas y un CHECK ampliado; nada se renombra ni se borra. Sin cambios en `contracts` ni en
 * `invoices`.
 *
 * 1. `contract_scheduled_changes` — ajustes pactados (§9.3.6): renovación con precio nuevo, IPC/UF, escalamientos, cambio de plazo o
 *    frecuencia. Entity `entities/contratos/contract-scheduled-change.entity.ts`.
 * 2. `contract_item_pauses` — pausas por ítem (§9.3.3, se usa desde B2-5). Entity `entities/contratos/contract-item-pause.entity.ts`.
 * 3. `contract_items.billing_anchor_day` — ciclo propio del ítem (§9.3.9); NULL = el del contrato.
 * 4. `holding_settings.auto_renewal_notice_days` — aviso previo de la propuesta de renovación (S2-3, §9.3.5).
 * 5. `revenue_schedule_monthly_momentum_check` suma `PAUSE` y `RESUME` (filas del tramo pausado y de la reanudación).
 *
 * RLS: TypeORM no lo modela; se activa aquí a mano y las 4 policies por tabla son assets (`rls/tenant_isolation_*_contract_scheduled_changes.sql`,
 * `rls/tenant_isolation_*_contract_item_pauses.sql`, mismas reglas que `contract_fx_period_rates`), igual que los triggers de `updated_at`
 * (`triggers/trg_contract_scheduled_changes_updated_at.sql`, `triggers/trg_contract_item_pauses_updated_at.sql`).
 *
 * Orden de despliegue: 1) esta migración, 2) los assets (policies, triggers y `revenue_schedule_rebuild_contract_ccy`, que lee
 * `contract_items.billing_anchor_day`), 3) el código que lee y escribe las columnas y tablas nuevas. Commit antes de aplicar,
 * `schema:status` + `schema:log` en QA antes de producción.
 */
export class ContractModificationsBlock21790710000000 implements MigrationInterface {
	name = 'ContractModificationsBlock21790710000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. contract_scheduled_changes
		await queryRunner.query(
			`CREATE TABLE "contract_scheduled_changes" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"contract_id" uuid NOT NULL,
				"contract_item_id" uuid,
				"group_key" uuid,
				"parent_id" uuid,
				"trigger" text NOT NULL,
				"effective_date" date,
				"anchor_date" date,
				"interval_months" smallint,
				"next_effective_date" date,
				"kind" text NOT NULL,
				"value" numeric(18,6) NOT NULL,
				"index_code" text,
				"index_base_date" date,
				"index_base_value" numeric(18,6),
				"index_lag_months" smallint DEFAULT 1,
				"rounding" text DEFAULT 'unit_2',
				"status" text NOT NULL DEFAULT 'scheduled',
				"status_reason" text,
				"status_changed_by" uuid,
				"applied_event_id" uuid,
				"applied_at" TIMESTAMP WITH TIME ZONE,
				"applied_value" numeric(18,6),
				"origin" jsonb NOT NULL DEFAULT '{"type":"manual"}',
				"notes" text,
				"created_by" uuid,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "contract_scheduled_changes_trigger_check" CHECK ("trigger" = ANY (ARRAY['on_renewal'::text, 'on_date'::text, 'every_n_months'::text])),
				CONSTRAINT "contract_scheduled_changes_kind_check" CHECK ("kind" = ANY (ARRAY['percent_uplift'::text, 'index'::text, 'new_unit_price'::text, 'quantity'::text, 'term'::text, 'billing_frequency'::text])),
				CONSTRAINT "contract_scheduled_changes_rounding_check" CHECK ("rounding" = ANY (ARRAY['none'::text, 'unit_2'::text, 'unit_0'::text, 'monthly_0'::text])),
				CONSTRAINT "contract_scheduled_changes_status_check" CHECK ("status" = ANY (ARRAY['scheduled'::text, 'applied'::text, 'skipped'::text, 'cancelled'::text])),
				CONSTRAINT "contract_scheduled_changes_interval_months_check" CHECK ("interval_months" IS NULL OR "interval_months" > 0),
				CONSTRAINT "contract_scheduled_changes_on_date_check" CHECK ("trigger" <> 'on_date' OR "effective_date" IS NOT NULL),
				CONSTRAINT "contract_scheduled_changes_every_n_months_check" CHECK ("trigger" <> 'every_n_months' OR ("anchor_date" IS NOT NULL AND "interval_months" IS NOT NULL)),
				CONSTRAINT "contract_scheduled_changes_index_check" CHECK ("kind" <> 'index' OR ("index_code" IS NOT NULL AND "index_base_value" IS NOT NULL)),
				CONSTRAINT "contract_scheduled_changes_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "contract_scheduled_changes" IS 'Ajustes pactados del contrato o de un ítem (renovación con precio, IPC/UF, escalamientos, plazo, frecuencia): disparo, valor y estado (spec modificaciones §9.3.6)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_scheduled_changes"."contract_item_id" IS 'Ítem al que aplica; NULL = alcance contrato (todos los recurrentes vigentes al aplicar)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_scheduled_changes"."parent_id" IS 'every_n_months: cada aplicación es una fila hija applied; la madre sigue scheduled con next_effective_date'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_scheduled_changes"."value" IS 'Según kind: % (percent_uplift; index = puntos sobre el índice), precio en moneda del ítem, cantidad o meses (term, billing_frequency)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_scheduled_changes"."applied_event_id" IS 'Evento (contract_lifecycle_events) del cambio que materializó el pacto'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_scheduled_changes"."applied_value" IS 'Valor efectivamente usado (índice real o valor editado en el acto)'`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_contract_scheduled_changes_contract_status" ON "contract_scheduled_changes" ("contract_id", "status")`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_contract_scheduled_changes_holding_status_next" ON "contract_scheduled_changes" ("holding_id", "status", "next_effective_date")`
		);
		await queryRunner.query(`CREATE INDEX "idx_contract_scheduled_changes_item" ON "contract_scheduled_changes" ("contract_item_id")`);
		await queryRunner.query(
			`ALTER TABLE "contract_scheduled_changes" ADD CONSTRAINT "contract_scheduled_changes_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_scheduled_changes" ADD CONSTRAINT "contract_scheduled_changes_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_scheduled_changes" ADD CONSTRAINT "contract_scheduled_changes_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_scheduled_changes" ADD CONSTRAINT "contract_scheduled_changes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "contract_scheduled_changes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_scheduled_changes" ADD CONSTRAINT "contract_scheduled_changes_applied_event_id_fkey" FOREIGN KEY ("applied_event_id") REFERENCES "contract_lifecycle_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "contract_scheduled_changes" ENABLE ROW LEVEL SECURITY`);

		// 2. contract_item_pauses
		await queryRunner.query(
			`CREATE TABLE "contract_item_pauses" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"contract_id" uuid NOT NULL,
				"contract_item_id" uuid NOT NULL,
				"pause_start" date NOT NULL,
				"pause_end" date,
				"extend_term" boolean NOT NULL DEFAULT false,
				"status" text NOT NULL DEFAULT 'scheduled',
				"reason" text,
				"pause_event_id" uuid,
				"resume_event_id" uuid,
				"created_by" uuid,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "contract_item_pauses_status_check" CHECK ("status" = ANY (ARRAY['scheduled'::text, 'active'::text, 'ended'::text, 'cancelled'::text])),
				CONSTRAINT "contract_item_pauses_dates_check" CHECK ("pause_end" IS NULL OR "pause_end" >= "pause_start"),
				CONSTRAINT "contract_item_pauses_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "contract_item_pauses" IS 'Pausas de servicio por ítem (spec modificaciones §9.3.3): devengo y MRR 0 en el tramo; pause_end NULL = hasta reanudar'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_item_pauses"."extend_term" IS 'Al reanudar, el fin del ítem se corre en los días pausados'`
		);
		await queryRunner.query(`CREATE INDEX "idx_contract_item_pauses_item_status" ON "contract_item_pauses" ("contract_item_id", "status")`);
		await queryRunner.query(
			`ALTER TABLE "contract_item_pauses" ADD CONSTRAINT "contract_item_pauses_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_item_pauses" ADD CONSTRAINT "contract_item_pauses_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_item_pauses" ADD CONSTRAINT "contract_item_pauses_contract_item_id_fkey" FOREIGN KEY ("contract_item_id") REFERENCES "contract_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_item_pauses" ADD CONSTRAINT "contract_item_pauses_pause_event_id_fkey" FOREIGN KEY ("pause_event_id") REFERENCES "contract_lifecycle_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_item_pauses" ADD CONSTRAINT "contract_item_pauses_resume_event_id_fkey" FOREIGN KEY ("resume_event_id") REFERENCES "contract_lifecycle_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "contract_item_pauses" ENABLE ROW LEVEL SECURITY`);

		// 3. contract_items.billing_anchor_day
		await queryRunner.query(`ALTER TABLE "contract_items" ADD "billing_anchor_day" smallint`);
		await queryRunner.query(
			`ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_billing_anchor_day_check" CHECK ("billing_anchor_day" IS NULL OR ("billing_anchor_day" >= 1 AND "billing_anchor_day" <= 31))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_items"."billing_anchor_day" IS 'Ciclo propio del ítem (1–31): sus períodos parten ese día, sin tramo prorrateado, y emite en su propia fecha. NULL = ciclo del contrato (contracts.billing_anchor_day)'`
		);

		// 4. holding_settings.auto_renewal_notice_days
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "auto_renewal_notice_days" smallint NOT NULL DEFAULT 30`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_auto_renewal_notice_days_check" CHECK ("auto_renewal_notice_days" >= 1 AND "auto_renewal_notice_days" <= 180)`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."auto_renewal_notice_days" IS 'Días de aviso previo de la propuesta de renovación automática (S2-3; default 30)'`
		);

		// 5. revenue_schedule_monthly_momentum_check + PAUSE, RESUME
		await queryRunner.query(`ALTER TABLE "revenue_schedule_monthly" DROP CONSTRAINT "revenue_schedule_monthly_momentum_check"`);
		await queryRunner.query(
			`ALTER TABLE "revenue_schedule_monthly" ADD CONSTRAINT "revenue_schedule_monthly_momentum_check" CHECK (momentum = ANY (ARRAY['NEW'::text, 'REACTIVATION'::text, 'UPSELL'::text, 'CROSS-SELL'::text, 'DOWNSELL'::text, 'CHURN'::text, 'RENEWAL'::text, 'BOP'::text, 'PENDING_RENEWAL'::text, 'PAUSE'::text, 'RESUME'::text]))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// No se revierte con datos que el esquema viejo no admite o que se perderían: se informan y se detiene.
		const [counts] = (await queryRunner.query(
			`SELECT
				(SELECT COUNT(*)::int FROM "revenue_schedule_monthly" WHERE "momentum" IN ('PAUSE', 'RESUME')) AS rsm,
				(SELECT COUNT(*)::int FROM "contract_scheduled_changes") AS pacts,
				(SELECT COUNT(*)::int FROM "contract_item_pauses") AS pauses,
				(SELECT COUNT(*)::int FROM "contract_items" WHERE "billing_anchor_day" IS NOT NULL) AS own_cycle`
		)) as Array<{ rsm: number; pacts: number; pauses: number; own_cycle: number }>;

		if (Number(counts?.rsm) || Number(counts?.pacts) || Number(counts?.pauses) || Number(counts?.own_cycle)) {
			throw new Error(
				`No se revierte: hay ${counts.rsm} filas de devengo PAUSE/RESUME, ${counts.pacts} pactos, ${counts.pauses} pausas y ${counts.own_cycle} ítems con ciclo propio. Muévelos o bórralos antes.`
			);
		}
		await queryRunner.query(`ALTER TABLE "revenue_schedule_monthly" DROP CONSTRAINT "revenue_schedule_monthly_momentum_check"`);
		await queryRunner.query(
			`ALTER TABLE "revenue_schedule_monthly" ADD CONSTRAINT "revenue_schedule_monthly_momentum_check" CHECK (momentum = ANY (ARRAY['NEW'::text, 'REACTIVATION'::text, 'UPSELL'::text, 'CROSS-SELL'::text, 'DOWNSELL'::text, 'CHURN'::text, 'RENEWAL'::text, 'BOP'::text, 'PENDING_RENEWAL'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "holding_settings" DROP CONSTRAINT "holding_settings_auto_renewal_notice_days_check"`);
		await queryRunner.query(`ALTER TABLE "holding_settings" DROP COLUMN "auto_renewal_notice_days"`);
		await queryRunner.query(`ALTER TABLE "contract_items" DROP CONSTRAINT "contract_items_billing_anchor_day_check"`);
		await queryRunner.query(`ALTER TABLE "contract_items" DROP COLUMN "billing_anchor_day"`);
		await queryRunner.query(`DROP TABLE "contract_item_pauses"`);
		await queryRunner.query(`DROP TABLE "contract_scheduled_changes"`);
	}
}

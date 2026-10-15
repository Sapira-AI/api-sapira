import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Onboarding de datos históricos y MRR histórico v2 (`docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` §3.5, aprobada por Domi
 * 13-10; se aplica con su OK: QA → prod). Solo esquema, sin tocar datos:
 *
 * - `holding_settings.metrics_history_start date NULL` (+ CHECK día 1): primer mes que muestran Métricas (§3.4).
 * - `invoices_legacy.import_batch_id uuid NULL` + índice parcial: lote reversible de facturas previas.
 * - `mrr_legacy.skip_reason_code text NULL` (`churn` | `duplicate` | `error`, CHECK): motivo normalizado; el texto libre sigue en
 *   `skip_activation_reason`. Las 1.615 filas marcadas hoy quedan en NULL y se leen con la regla de `mrr-historico.ts` (sin migrar datos).
 * - tabla `onboarding_events` (entity `entities/legacy/onboarding-event.entity.ts`): registro de cambios del módulo. RLS activada aquí; la
 *   policy es el asset `rls/holding_access_onboarding_events.sql`.
 *
 * La API funciona antes de aplicarla en todo lo que no es el módulo `onboarding`: Métricas, Cliente 360 y Preferencias leen las columnas
 * nuevas con `to_jsonb(...)` (ausente → NULL). **NO APLICADA** al 13-10.
 */
export class OnboardingDatosHistoricos1791900000000 implements MigrationInterface {
	name = 'OnboardingDatosHistoricos1791900000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "metrics_history_start" date`);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."metrics_history_start" IS 'Inicio de la historia en Métricas: primer mes que se muestra (día 1). NULL = desde el primer dato'`
		);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_metrics_history_start_check" CHECK ("metrics_history_start" IS NULL OR date_trunc('month', "metrics_history_start"::timestamp)::date = "metrics_history_start")`
		);

		await queryRunner.query(`ALTER TABLE "invoices_legacy" ADD "import_batch_id" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoices_legacy"."import_batch_id" IS 'Lote de importación de facturas previas (módulo onboarding): permite revertir lo importado en una pasada'`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_invoices_legacy_import_batch_id" ON "invoices_legacy" ("import_batch_id") WHERE import_batch_id IS NOT NULL`
		);

		await queryRunner.query(`ALTER TABLE "mrr_legacy" ADD "skip_reason_code" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "mrr_legacy"."skip_reason_code" IS 'Motivo normalizado del skip_activation: churn (fue baja) | duplicate | error (quitada, no cuenta). El texto libre queda en skip_activation_reason'`
		);
		await queryRunner.query(
			`ALTER TABLE "mrr_legacy" ADD CONSTRAINT "mrr_legacy_skip_reason_code_check" CHECK ((skip_reason_code IS NULL) OR (skip_reason_code = ANY (ARRAY['churn'::text, 'duplicate'::text, 'error'::text])))`
		);

		await queryRunner.query(
			`CREATE TABLE "onboarding_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "type" text NOT NULL, "line_key" text, "entity_type" text, "entity_id" uuid, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "actor_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "onboarding_events_pkey" PRIMARY KEY ("id")); COMMENT ON COLUMN "onboarding_events"."type" IS 'Tipo de cambio (history_linked, previous_invoices_imported, quick_start_applied, …)'; COMMENT ON COLUMN "onboarding_events"."line_key" IS 'Línea de MRR histórico: client_id|product_name|contract_currency (sin codificar)'`
		);
		await queryRunner.query(`CREATE INDEX "idx_onboarding_events_holding_created" ON "onboarding_events" ("holding_id", "created_at") `);
		await queryRunner.query(
			`CREATE INDEX "idx_onboarding_events_holding_line" ON "onboarding_events" ("holding_id", "line_key") WHERE line_key IS NOT NULL`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_onboarding_events_holding_entity" ON "onboarding_events" ("holding_id", "entity_id") WHERE entity_id IS NOT NULL`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "onboarding_events" IS 'Registro de cambios del onboarding de datos históricos (MRR histórico, facturas previas, arranque rápido). Solo la API escribe'`
		);
		await queryRunner.query(
			`ALTER TABLE "onboarding_events" ADD CONSTRAINT "onboarding_events_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "onboarding_events" ADD CONSTRAINT "onboarding_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "onboarding_events" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP POLICY IF EXISTS "holding_access_onboarding_events" ON "onboarding_events"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "onboarding_events"`);
		await queryRunner.query(`ALTER TABLE "mrr_legacy" DROP CONSTRAINT IF EXISTS "mrr_legacy_skip_reason_code_check"`);
		await queryRunner.query(`ALTER TABLE "mrr_legacy" DROP COLUMN IF EXISTS "skip_reason_code"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_legacy_import_batch_id"`);
		await queryRunner.query(`ALTER TABLE "invoices_legacy" DROP COLUMN IF EXISTS "import_batch_id"`);
		await queryRunner.query(`ALTER TABLE "holding_settings" DROP CONSTRAINT IF EXISTS "holding_settings_metrics_history_start_check"`);
		await queryRunner.query(`ALTER TABLE "holding_settings" DROP COLUMN IF EXISTS "metrics_history_start"`);
	}
}

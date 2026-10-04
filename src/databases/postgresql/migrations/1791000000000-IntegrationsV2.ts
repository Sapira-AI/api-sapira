import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integraciones v2 (`docs/v2-rediseno/contrato-api-integraciones.md` §8). Aditiva: el front actual no conoce nada de esto.
 *
 * - I1 · `sellers.crm_owner_id` (D7): dueño del CRM que corresponde al vendedor + índice único parcial por holding. Entity:
 *   `entities/clientes/seller.entity.ts`.
 * - I2 · tabla única de ajustes por integración: reutiliza `holding_integration_settings` de Leon (`1790400000000`, ya en QA y producción)
 *   y le agrega `settings jsonb` (reglas del tipo: etapas del CRM, filtros del ERP, reglas de exclusión) y `updated_by`, más `stripe` en su
 *   CHECK (mismo nombre de constraint). Tipo → `integration`: erp → odoo, crm → salesforce, stripe → stripe, datos → bigquery. Entity:
 *   `entities/base-tenancy/holding-integration-settings.entity.ts` (la de Leon + estas columnas).
 * - I3 · `integration_record_discards`: registros de tablas intermedias que el usuario descartó. Entity:
 *   `entities/integraciones/otras/integration-record-discard.entity.ts`.
 *
 * I3: FK al holding ON DELETE CASCADE y **RLS activo sin policies** (solo la API, con BYPASSRLS). I2 conserva su RLS y su policy.
 * Debe aplicarse antes de desplegar la API de Integraciones v2. **NO APLICADA** al 03-10.
 */
export class IntegrationsV21791000000000 implements MigrationInterface {
	name = 'IntegrationsV21791000000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// I1
		await queryRunner.query(`ALTER TABLE "sellers" ADD "crm_owner_id" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "sellers"."crm_owner_id" IS 'Id del dueño (usuario) en el CRM que corresponde a este vendedor. Único por holding'`
		);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "sellers_holding_crm_owner_key" ON "sellers" ("holding_id", "crm_owner_id") WHERE (crm_owner_id IS NOT NULL)`
		);

		// I2
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" ADD "settings" jsonb NOT NULL DEFAULT '{}'::jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_integration_settings"."settings" IS 'Reglas de la integración para el holding (claves según el contrato de Integraciones v2 §6.1 y §6.5). {} = valores por defecto'`
		);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" ADD "updated_by" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_integration_settings"."updated_by" IS 'Usuario (public.users.id) que cambió los ajustes por última vez'`
		);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP CONSTRAINT "holding_integration_settings_integration_check"`);
		await queryRunner.query(
			`ALTER TABLE "holding_integration_settings" ADD CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery', 'stripe'))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "holding_integration_settings" IS 'Ajustes de cada integración por holding: habilitación de la corrida automática (cron; fila ausente = habilitado) y reglas (settings).'`
		);

		// I3
		await queryRunner.query(
			`CREATE TABLE "integration_record_discards" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "tipo" text NOT NULL, "object" text NOT NULL, "record_key" text NOT NULL, "reason" text, "discarded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "integration_record_discards_key" UNIQUE ("holding_id", "tipo", "object", "record_key"), CONSTRAINT "integration_record_discards_tipo_check" CHECK (tipo = ANY (ARRAY['erp'::text, 'crm'::text, 'stripe'::text, 'datos'::text])), CONSTRAINT "integration_record_discards_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`ALTER TABLE "integration_record_discards" ADD CONSTRAINT "integration_record_discards_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "integration_record_discards" IS 'Registros de tablas intermedias de integraciones descartados por el usuario (no se importan). Solo la API'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "integration_record_discards"."tipo" IS 'Tipo de integración: erp, crm, stripe o datos'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "integration_record_discards"."object" IS 'Objeto del registro según la API (customer, opportunity, consumption…)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "integration_record_discards"."record_key" IS 'Identificador externo del registro (external_id en la API de Integraciones)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "integration_record_discards"."reason" IS 'Motivo opcional del descarte'`);
		await queryRunner.query(`COMMENT ON COLUMN "integration_record_discards"."discarded_by" IS 'Usuario (public.users.id) que lo descartó'`);
		await queryRunner.query(`ALTER TABLE "integration_record_discards" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "integration_record_discards"`);
		await queryRunner.query(
			`COMMENT ON TABLE "holding_integration_settings" IS 'Habilitación de la integración automática (cron) de cada servicio, por holding. Fila ausente = habilitado.'`
		);
		await queryRunner.query(`DELETE FROM "holding_integration_settings" WHERE integration = 'stripe'`);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP CONSTRAINT "holding_integration_settings_integration_check"`);
		await queryRunner.query(
			`ALTER TABLE "holding_integration_settings" ADD CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery'))`
		);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP COLUMN "updated_by"`);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP COLUMN "settings"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "public"."sellers_holding_crm_owner_key"`);
		await queryRunner.query(`ALTER TABLE "sellers" DROP COLUMN IF EXISTS "crm_owner_id"`);
	}
}

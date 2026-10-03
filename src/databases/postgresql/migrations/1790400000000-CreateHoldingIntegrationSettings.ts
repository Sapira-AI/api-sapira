import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Interruptor por holding de la integración automática de cada servicio (pedido de Leon, 27-09-2026).
 *
 * `holding_integration_settings` (entity `HoldingIntegrationSettings`): PK compuesta `(holding_id, integration)`
 * con `integration` acotado a `odoo | salesforce | bigquery`. **Fila ausente = habilitado**: todo se lee con
 * `COALESCE(auto_enabled, true)`, así que la tabla nace vacía, no hace falta backfill y ningún holding cambia de
 * comportamiento al aplicar esta migración. Solo se inserta la fila cuando alguien apaga (o vuelve a prender).
 *
 * Lo consume hoy el cron de envío de facturas a Odoo, que pasa a crear una corrida por holding en vez de una
 * sola con `holdingId: 'all'`. El envío manual **no** mira este flag a propósito: queda como válvula de escape.
 *
 * Solo la usa la API: RLS activo y una única policy para `service_role` (asset `rls/`), sin grants al Data API
 * (el front viejo no la lee; el nuevo la consumirá vía API cuando se migre el módulo Integraciones).
 *
 * ⚠️ Orden de despliegue: correr esta migración ANTES de desplegar el código que declara la entity. Al revés,
 * TypeORM seleccionaría una tabla inexistente.
 */
export class CreateHoldingIntegrationSettings1790400000000 implements MigrationInterface {
	name = 'CreateHoldingIntegrationSettings1790400000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "holding_integration_settings" ("holding_id" uuid NOT NULL, "integration" text NOT NULL, "auto_enabled" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery')), CONSTRAINT "holding_integration_settings_pkey" PRIMARY KEY ("holding_id", "integration")); COMMENT ON COLUMN "holding_integration_settings"."auto_enabled" IS 'false apaga la corrida automática de esa integración para el holding'`
		);
		await queryRunner.query(
			`ALTER TABLE "holding_integration_settings" ADD CONSTRAINT "holding_integration_settings_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "holding_integration_settings" IS 'Habilitación de la integración automática (cron) de cada servicio, por holding. Fila ausente = habilitado.'`
		);
		// TypeORM no modela RLS: sin esto la tabla nace legible para `anon` (GRANT ALL de la base).
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "holding_integration_settings"`);
	}
}

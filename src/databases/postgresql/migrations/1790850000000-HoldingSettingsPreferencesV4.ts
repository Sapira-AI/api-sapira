import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M14 · Configuración v2 ronda 4 (decisiones de Domi 03-10): **preferencias del holding que ya funcionan**. Una sola migración aditiva en
 * `holding_settings`; cada default reproduce exactamente el comportamiento anterior (las 7 filas de producción quedan igual que hoy):
 *
 * 1. `timezone text` default `America/Santiago`: zona IANA con la que cada holding calcula su "hoy" (la API la valida contra
 *    `Intl.supportedValuesOf('timeZone')`; aquí solo un CHECK de largo).
 * 2. `renewal_reminder_days smallint[]` default `{15,7,0}` (1–10 valores, 0–180) y `renewal_overdue_every_days smallint` default 7
 *    (1–90): escalera de recordatorios de vencimiento (job `contracts-renewal-reminders`).
 * 3. Numeración de cotizaciones creadas en Sapira: `quote_numbering_mode` (`prefixed` | `sequential` | `manual`, default `prefixed`),
 *    `quote_number_prefix` (default `COT`), `quote_number_include_year` (default true) y `quote_number_width` (default 4, 1–8) =
 *    `COT-{año}-{NNNN}`, el formato actual.
 *
 * El horizonte de ítems sin término **no** es columna: es fijo en 12 períodos por sistema (Domi 03-10, calendario rodante).
 *
 * Entity `entities/base-tenancy/holding-settings.entity.ts` (generada desde prod): se actualiza junto con `schema:snapshot` después de
 * aplicar en producción (si se edita antes, `base-tenancy.entities.spec` falla por deriva). La API lee con `to_jsonb` y defaults, así que no
 * se cae si se despliega antes de aplicar; solo el PATCH de preferencias la necesita. **NO APLICADA** al 03-10.
 */
export class HoldingSettingsPreferencesV41790850000000 implements MigrationInterface {
	name = 'HoldingSettingsPreferencesV41790850000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "timezone" text NOT NULL DEFAULT 'America/Santiago'`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_timezone_check" CHECK (char_length("timezone") BETWEEN 1 AND 64)`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."timezone" IS 'Zona horaria IANA del holding: define su fecha de hoy (default America/Santiago)'`
		);

		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "renewal_reminder_days" smallint[] NOT NULL DEFAULT '{15,7,0}'`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_renewal_reminder_days_check" CHECK (cardinality("renewal_reminder_days") BETWEEN 1 AND 10 AND 0 <= ALL("renewal_reminder_days") AND 180 >= ALL("renewal_reminder_days"))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."renewal_reminder_days" IS 'Escalera de recordatorios de vencimiento: días antes del fin, de mayor a menor (default 15,7,0)'`
		);
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "renewal_overdue_every_days" smallint NOT NULL DEFAULT 7`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_renewal_overdue_every_days_check" CHECK ("renewal_overdue_every_days" >= 1 AND "renewal_overdue_every_days" <= 90)`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."renewal_overdue_every_days" IS 'Vencido sin decisión: un recordatorio cada N días (default 7)'`
		);

		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "quote_numbering_mode" text NOT NULL DEFAULT 'prefixed'`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_quote_numbering_mode_check" CHECK ("quote_numbering_mode" = ANY (ARRAY['prefixed'::text, 'sequential'::text, 'manual'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "quote_number_prefix" text NOT NULL DEFAULT 'COT'`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_quote_number_prefix_check" CHECK ("quote_number_prefix" ~ '^[A-Za-z0-9]{1,10}$')`
		);
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "quote_number_include_year" boolean NOT NULL DEFAULT true`);
		await queryRunner.query(`ALTER TABLE "holding_settings" ADD "quote_number_width" smallint NOT NULL DEFAULT 4`);
		await queryRunner.query(
			`ALTER TABLE "holding_settings" ADD CONSTRAINT "holding_settings_quote_number_width_check" CHECK ("quote_number_width" >= 1 AND "quote_number_width" <= 8)`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "holding_settings"."quote_numbering_mode" IS 'Numeración de cotizaciones creadas en Sapira: prefixed (prefijo-año-correlativo), sequential o manual'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const constraint of [
			'holding_settings_quote_number_width_check',
			'holding_settings_quote_number_prefix_check',
			'holding_settings_quote_numbering_mode_check',
			'holding_settings_renewal_overdue_every_days_check',
			'holding_settings_renewal_reminder_days_check',
			'holding_settings_timezone_check',
		]) {
			await queryRunner.query(`ALTER TABLE "holding_settings" DROP CONSTRAINT IF EXISTS "${constraint}"`);
		}
		for (const column of [
			'quote_number_width',
			'quote_number_include_year',
			'quote_number_prefix',
			'quote_numbering_mode',
			'renewal_overdue_every_days',
			'renewal_reminder_days',
			'timezone',
		]) {
			await queryRunner.query(`ALTER TABLE "holding_settings" DROP COLUMN IF EXISTS "${column}"`);
		}
	}
}

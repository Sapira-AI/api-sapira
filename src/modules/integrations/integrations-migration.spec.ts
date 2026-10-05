import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Migración I1–I3 (contrato §8): aditiva, tabla de descartes con RLS activada sin políticas, tipos con `stripe` (no `pagos`) y ajustes en la
 * tabla de Leon `holding_integration_settings` (sin tabla nueva). Escrita sin aplicar.
 */
describe('Migración 1791000000000-IntegrationsV2', () => {
	const sql = readFileSync(join(__dirname, '..', '..', 'databases', 'postgresql', 'migrations', '1791000000000-IntegrationsV2.ts'), 'utf8');
	const up = sql.slice(sql.indexOf('async up'), sql.indexOf('async down'));

	it('agrega sellers.crm_owner_id con índice único parcial por holding', () => {
		expect(up).toContain('ALTER TABLE "sellers" ADD "crm_owner_id" text');
		expect(up).toContain(
			'CREATE UNIQUE INDEX "sellers_holding_crm_owner_key" ON "sellers" ("holding_id", "crm_owner_id") WHERE (crm_owner_id IS NOT NULL)'
		);
	});

	it('ajustes en holding_integration_settings: settings jsonb, updated_by y stripe en el mismo CHECK (sin tabla integration_settings)', () => {
		expect(up).toContain(`ALTER TABLE "holding_integration_settings" ADD "settings" jsonb NOT NULL DEFAULT '{}'::jsonb`);
		expect(up).toContain('ALTER TABLE "holding_integration_settings" ADD "updated_by" uuid');
		expect(up).toContain('COMMENT ON COLUMN "holding_integration_settings"."settings"');
		expect(up).toContain(
			`ADD CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery', 'stripe'))`
		);
		expect(sql).not.toMatch(/"integration_settings"/);
	});

	it('crea la tabla de descartes con RLS activa, sin políticas, y tipos erp/crm/stripe/datos', () => {
		expect(up.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(1);
		expect(up).not.toContain('CREATE POLICY');
		expect(up).toContain("'stripe'::text");
		expect(up).not.toContain("'pagos'");
		expect(up).toContain('CONSTRAINT "integration_record_discards_key" UNIQUE ("holding_id", "tipo", "object", "record_key")');
	});

	it('no borra nada en el up (solo reemplaza el CHECK de holding_integration_settings)', () => {
		expect(up.replace('DROP CONSTRAINT "holding_integration_settings_integration_check"', '')).not.toMatch(/DROP |DELETE FROM|UPDATE "/);
	});
});

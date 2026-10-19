import { readFileSync } from 'fs';
import { join } from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '@/databases/postgresql/entities/espejo.existing';
import * as espejoTodos from '@/databases/postgresql/entities/espejo.index';

import { ErpExport } from './erp-export.entity';
import { KameCompanySettings } from './kame-company-settings.entity';
import { KameConnection } from './kame-connection.entity';

/**
 * Integración con Kame: las entities definen las tablas y la migración `1792200000000-KameIntegration` (escrita a mano) las crea con los
 * mismos nombres. Tablas propias de api-sapira (aún no existen en producción, así que no hay snapshot contra el cual medirlas).
 */
describe('entities de Kame', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const meta = (target: unknown) => dataSource.entityMetadatas.find((entry) => entry.target === target) as EntityMetadata;
	const migration = readFileSync(join(__dirname, '..', '..', '..', 'migrations', '1792200000000-KameIntegration.ts'), 'utf8');
	const up = migration.slice(migration.indexOf('async up'), migration.indexOf('async down'));

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
	});

	it('kame_connections: una credencial por compañía y ambiente, con el secret cifrado', () => {
		const metadata = meta(KameConnection);

		expect(metadata.tableName).toBe('kame_connections');
		expect(metadata.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)])).toEqual([
			['kame_connections_company_environment_key', ['company_id', 'environment']],
		]);
		expect(metadata.columns.map((column) => column.databaseName)).toContain('client_secret_encrypted');
		expect(metadata.columns.map((column) => column.databaseName)).not.toContain('client_secret');
		expect(metadata.foreignKeys.map((fk) => fk.name).sort()).toEqual(['kame_connections_company_id_fkey', 'kame_connections_holding_id_fkey']);
		expect(up).toContain('CONSTRAINT "kame_connections_company_environment_key" UNIQUE ("company_id", "environment")');
	});

	it('kame_company_settings: todo nace apagado, en pruebas y en simulación', () => {
		const columns = Object.fromEntries(meta(KameCompanySettings).columns.map((column) => [column.databaseName, column.default]));

		expect(columns).toMatchObject({ active_environment: 'pruebas', enabled: false, send_invoices: false, send_journal: false, dry_run: true });
		expect(up).toContain(`"active_environment" text NOT NULL DEFAULT 'pruebas', "enabled" boolean NOT NULL DEFAULT false`);
		expect(up).toContain(`"dry_run" boolean NOT NULL DEFAULT true`);
	});

	it('erp_exports: la idempotencia son dos índices únicos parciales por ambiente', () => {
		const indices = meta(ErpExport).indices.map((index) => [index.name, index.isUnique, index.where ?? null]);

		expect(indices).toEqual(
			expect.arrayContaining([
				['erp_exports_invoice_key', true, `(object = 'invoice'::text)`],
				['erp_exports_journal_key', true, `(object = 'journal'::text)`],
			])
		);
		expect(up).toContain(
			`CREATE UNIQUE INDEX "erp_exports_invoice_key" ON "erp_exports" ("system", "environment", "invoice_id") WHERE (object = 'invoice'::text)`
		);
		expect(up).toContain(
			`CREATE UNIQUE INDEX "erp_exports_journal_key" ON "erp_exports" ("system", "environment", "company_id", "period") WHERE (object = 'journal'::text)`
		);
		expect(
			meta(ErpExport)
				.checks.map((check) => check.name)
				.sort()
		).toEqual([
			'erp_exports_environment_check',
			'erp_exports_object_check',
			'erp_exports_status_check',
			'erp_exports_system_check',
			'erp_exports_target_check',
		]);
	});

	it('la migración: RLS activo sin policies en las tres tablas, kame en el CHECK y sin borrar nada en el up', () => {
		expect(up.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3);
		expect(migration).not.toContain('CREATE POLICY');
		expect(up).toContain(`CHECK (integration IN ('odoo', 'salesforce', 'bigquery', 'stripe', 'kame'))`);
		expect(up.replace('DROP CONSTRAINT "holding_integration_settings_integration_check"', '')).not.toMatch(/DROP |DELETE FROM|UPDATE "/);
		expect(migration).not.toMatch(/GRANT /);
	});
});

import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../espejo.existing';
import * as espejoTodos from '../espejo.index';

import { InvoiceAdjustment } from './invoice-adjustment.entity';
import { INVOICE_ITEM_QUANTITY_SOURCES, InvoiceItem } from './invoice-item.entity';
import { Invoice } from './invoice.entity';

/**
 * Facturas en el Contrato 360 · etapa 4 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.4): sin columnas nuevas, tres CHECK
 * ampliados por entity + migración `1790680000000-InvoiceEditChecks`. Este spec fija lo que declaran las entities y lo que la migración
 * escrita a mano hace, sin conectarse a ninguna base.
 */
describe('Editar una Por Emitir (entities + migración 1790680000000)', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const byTarget = new Map<unknown, EntityMetadata>();
	const check = (target: unknown, name: string) => byTarget.get(target)!.checks.find((entry) => entry.name === name)?.expression ?? '';

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		for (const entry of dataSource.entityMetadatas) byTarget.set(entry.target, entry);
	});

	it('las entities declaran los CHECK ampliados (correction, manual, service_period) conservando los valores anteriores', () => {
		expect(dataSource.isInitialized).toBe(false);
		const adjustment = check(InvoiceAdjustment, 'invoice_adjustments_type_check');
		const source = check(InvoiceItem, 'invoice_items_quantity_source_check');
		const treatment = check(Invoice, 'invoices_nc_revenue_treatment_check');

		for (const value of ['discount', 'downsell', 'upsell', 'reagenda', 'correction']) expect(adjustment).toContain(`'${value}'::text`);
		for (const value of ['fixed', 'consumption', 'estimated', 'pending', 'manual']) expect(source).toContain(`'${value}'::text`);
		expect(source).toContain('"quantity_source" IS NULL');
		for (const value of ['impact_month', 'defer_forward', 'service_period']) expect(treatment).toContain(`'${value}'::text`);
		expect(treatment).toContain('nc_revenue_treatment IS NULL');
		expect(INVOICE_ITEM_QUANTITY_SOURCES).toContain('manual');
	});

	it('no agrega columnas: invoices, invoice_items e invoice_adjustments no tienen plan_deviation, source ni is_visible', () => {
		const columns = (target: unknown) => byTarget.get(target)!.columns.map((entry) => entry.databaseName);

		expect(columns(Invoice)).not.toContain('plan_deviation');
		expect(columns(Invoice)).not.toContain('updated_at');
		expect(columns(InvoiceItem)).not.toContain('source');
		expect(columns(InvoiceItem)).not.toContain('is_visible');
		expect(columns(InvoiceAdjustment)).toEqual(
			expect.arrayContaining(['invoice_id', 'type', 'amount_diff', 'notes', 'adjusted_by', 'adjusted_at', 'holding_id', 'created_at'])
		);
	});

	describe('migración', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '1790680000000-InvoiceEditChecks.ts'), 'utf8');
		const up = source.slice(source.indexOf('async up('), source.indexOf('async down('));
		const down = source.slice(source.indexOf('async down('));

		it('el up solo redefine los tres CHECK (drop + add del mismo nombre) y comenta dos columnas: sin columnas, tablas, triggers ni funciones', () => {
			for (const name of ['invoice_adjustments_type_check', 'invoice_items_quantity_source_check', 'invoices_nc_revenue_treatment_check']) {
				expect(up).toContain(`DROP CONSTRAINT "${name}"`);
				expect(up).toContain(`ADD CONSTRAINT "${name}" CHECK`);
			}
			expect(up.match(/DROP CONSTRAINT/g)).toHaveLength(3);
			expect(up.match(/ADD CONSTRAINT/g)).toHaveLength(3);
			expect(up).toContain(`'correction'::text`);
			expect(up).toContain(`'manual'::text`);
			expect(up).toContain(`'service_period'::text`);
			expect(up).not.toMatch(/ADD "|DROP COLUMN|CREATE TABLE|TRIGGER|FUNCTION|UPDATE |DELETE /);
		});

		it('el down restaura los CHECK anteriores (sin los valores nuevos)', () => {
			expect(down.match(/ADD CONSTRAINT/g)).toHaveLength(3);
			expect(down).not.toContain(`'correction'::text`);
			expect(down).not.toContain(`'manual'::text`);
			expect(down).not.toContain(`'service_period'::text`);
			expect(down).toContain(`ARRAY['discount'::text, 'downsell'::text, 'upsell'::text, 'reagenda'::text]`);
		});

		it('la clase declara el mismo name que su nombre (lo exige schema-status)', () => {
			expect(source).toContain('export class InvoiceEditChecks1790680000000');
			expect(source).toContain(`name = 'InvoiceEditChecks1790680000000'`);
		});
	});
});

import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../espejo.existing';
import * as espejoTodos from '../espejo.index';
import { InvoiceItem } from '../facturacion/invoice-item.entity';

import { BillableMetric } from './billable-metric.entity';
import { ConsumptionEntryRevision } from './consumption-entry-revision.entity';
import { ConsumptionEntry } from './consumption-entry.entity';
import { ContractItem } from './contract-item.entity';
import { Price } from './price.entity';

/**
 * Pricing v2 (`docs/v2-rediseno/spec-pricing-v2.md` §2): las cuatro tablas nuevas y las columnas agregadas nacen por entity +
 * migración `1790630000000-CreatePricingV2` (GUIA → Crear una tabla nueva), sin snapshot de prod que las mida. Este spec fija
 * lo que declaran las entities, lo que la migración tiene que crear y los assets RLS, sin conectarse a ninguna base.
 */
describe('Pricing v2 (entities + migración + RLS)', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const byTarget = new Map<unknown, EntityMetadata>();
	const meta = (target: unknown) => byTarget.get(target)!;
	const columns = (entity: EntityMetadata) => Object.fromEntries(entity.columns.map((column) => [column.databaseName, column.isNullable]));
	const fks = (entity: EntityMetadata) =>
		Object.fromEntries(entity.foreignKeys.map((fk) => [fk.name, { table: fk.referencedEntityMetadata.tableName, onDelete: fk.onDelete }]));
	const indexes = (entity: EntityMetadata) =>
		Object.fromEntries(
			entity.indices
				.filter((index) => index.synchronize !== false)
				.map((index) => [
					index.name,
					{ columns: index.columns.map((column) => column.databaseName), unique: index.isUnique, where: index.where ?? null },
				])
		);

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		for (const entry of dataSource.entityMetadatas) byTarget.set(entry.target, entry);
	});

	it('billable_metrics: columnas, UNIQUE por holding + código, CHECKs y FKs con sus nombres reales', () => {
		const entity = meta(BillableMetric);

		expect(entity.tableName).toBe('billable_metrics');
		expect(columns(entity)).toEqual({
			id: false,
			holding_id: false,
			code: false,
			name: false,
			description: true,
			aggregation: false,
			unit: false,
			source_kind: false,
			source_config: false,
			status: false,
			created_at: false,
			updated_at: false,
			created_by: true,
			updated_by: true,
			archived_at: true,
		});
		expect(Object.fromEntries(entity.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))).toEqual({
			billable_metrics_holding_id_code_key: ['holding_id', 'code'],
		});
		expect(entity.checks.map((check) => check.name).sort()).toEqual([
			'billable_metrics_aggregation_check',
			'billable_metrics_source_kind_check',
			'billable_metrics_status_check',
		]);
		expect(fks(entity)).toEqual({
			billable_metrics_holding_id_fkey: { table: 'company_holdings', onDelete: 'CASCADE' },
			billable_metrics_created_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
			billable_metrics_updated_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
		});
		expect(indexes(entity)).toEqual({ idx_billable_metrics_holding_status: { columns: ['holding_id', 'status'], unique: false, where: null } });
	});

	it('prices: modelo, cantidad, tramos, condiciones, versiones, CHECKs de coherencia, índices (parcial por contrato) y FKs', () => {
		const entity = meta(Price);

		expect(entity.tableName).toBe('prices');
		expect(columns(entity)).toEqual({
			id: false,
			holding_id: false,
			owner: false,
			product_id: false,
			contract_id: true,
			quote_id: true,
			name: false,
			currency: false,
			model: false,
			quantity_type: false,
			billable_metric_id: true,
			unit_amount: true,
			tiers: true,
			package_size: true,
			package_amount: true,
			seat_minimum_quantity: true,
			free_units: true,
			minimum_amount: true,
			cap_amount: true,
			invoice_line_mode: false,
			charge_flat_when_free: false,
			status: false,
			version: false,
			supersedes_price_id: true,
			list_price_id: true,
			notes: true,
			created_at: false,
			updated_at: false,
			created_by: true,
			updated_by: true,
			published_at: true,
			archived_at: true,
		});
		expect(entity.checks.map((check) => check.name).sort()).toEqual([
			'prices_cap_minimum_check',
			'prices_contract_owner_check',
			'prices_invoice_line_mode_check',
			'prices_metered_metric_check',
			'prices_model_check',
			'prices_owner_check',
			'prices_quantity_type_check',
			'prices_status_check',
		]);
		expect(fks(entity)).toEqual({
			prices_holding_id_fkey: { table: 'company_holdings', onDelete: 'CASCADE' },
			prices_product_id_fkey: { table: 'products', onDelete: 'NO ACTION' },
			prices_contract_id_fkey: { table: 'contracts', onDelete: 'CASCADE' },
			prices_quote_id_fkey: { table: 'quotes', onDelete: 'CASCADE' },
			prices_billable_metric_id_fkey: { table: 'billable_metrics', onDelete: 'NO ACTION' },
			prices_supersedes_price_id_fkey: { table: 'prices', onDelete: 'NO ACTION' },
			prices_list_price_id_fkey: { table: 'prices', onDelete: 'NO ACTION' },
			prices_created_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
			prices_updated_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
		});
		expect(indexes(entity)).toEqual({
			idx_prices_holding_product_status: { columns: ['holding_id', 'product_id', 'status'], unique: false, where: null },
			idx_prices_contract_id: { columns: ['contract_id'], unique: false, where: `owner = 'contract'` },
			idx_prices_quote_id: { columns: ['quote_id'], unique: false, where: `owner = 'quote'` },
			idx_prices_billable_metric_id: { columns: ['billable_metric_id'], unique: false, where: null },
		});
		const numeric = (name: string) => entity.columns.find((column) => column.databaseName === name)!;

		expect([numeric('unit_amount').precision, numeric('unit_amount').scale]).toEqual([18, 6]);
		expect([numeric('minimum_amount').precision, numeric('minimum_amount').scale]).toEqual([18, 2]);
	});

	it('consumption_entries: una fila vigente por ítem y período, idempotencia parcial por holding, CHECKs y FKs en cascada', () => {
		const entity = meta(ConsumptionEntry);

		expect(entity.tableName).toBe('consumption_entries');
		expect(columns(entity)).toEqual({
			id: false,
			holding_id: false,
			contract_id: false,
			contract_item_id: false,
			period_start: false,
			period_end: false,
			quantity: false,
			amount_override: true,
			apply_item_discount: false,
			account: true,
			is_estimated: false,
			source: false,
			idempotency_key: true,
			revision: false,
			correction_reason: true,
			notes: true,
			invoice_id: true,
			created_at: false,
			updated_at: false,
			created_by: true,
			updated_by: true,
		});
		expect(Object.fromEntries(entity.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))).toEqual({
			consumption_entries_contract_item_id_period_start_key: ['contract_item_id', 'period_start'],
		});
		expect(entity.checks.map((check) => check.name).sort()).toEqual([
			'consumption_entries_period_check',
			'consumption_entries_quantity_check',
			'consumption_entries_source_check',
		]);
		expect(fks(entity)).toEqual({
			consumption_entries_holding_id_fkey: { table: 'company_holdings', onDelete: 'CASCADE' },
			consumption_entries_contract_id_fkey: { table: 'contracts', onDelete: 'CASCADE' },
			consumption_entries_contract_item_id_fkey: { table: 'contract_items', onDelete: 'CASCADE' },
			consumption_entries_invoice_id_fkey: { table: 'invoices', onDelete: 'SET NULL' },
			consumption_entries_created_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
			consumption_entries_updated_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
		});
		expect(indexes(entity)).toEqual({
			idx_consumption_entries_idempotency: { columns: ['holding_id', 'idempotency_key'], unique: true, where: 'idempotency_key IS NOT NULL' },
			idx_consumption_entries_contract_period: { columns: ['contract_id', 'period_start'], unique: false, where: null },
			idx_consumption_entries_holding_id: { columns: ['holding_id'], unique: false, where: null },
			idx_consumption_entries_invoice_id: { columns: ['invoice_id'], unique: false, where: 'invoice_id IS NOT NULL' },
		});
	});

	it('consumption_entry_revisions: append-only, UNIQUE (entry, revisión) y cascada desde la entry', () => {
		const entity = meta(ConsumptionEntryRevision);

		expect(entity.tableName).toBe('consumption_entry_revisions');
		expect(columns(entity)).toEqual({
			id: false,
			holding_id: false,
			entry_id: false,
			revision: false,
			quantity: false,
			amount_override: true,
			apply_item_discount: false,
			source: false,
			reason: true,
			changed_by: true,
			changed_at: false,
		});
		expect(Object.fromEntries(entity.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))).toEqual({
			consumption_entry_revisions_entry_id_revision_key: ['entry_id', 'revision'],
		});
		expect(fks(entity)).toEqual({
			consumption_entry_revisions_holding_id_fkey: { table: 'company_holdings', onDelete: 'CASCADE' },
			consumption_entry_revisions_entry_id_fkey: { table: 'consumption_entries', onDelete: 'CASCADE' },
			consumption_entry_revisions_changed_by_fkey: { table: 'users', onDelete: 'NO ACTION' },
		});
	});

	it('contract_items.price_id (FK + índice, opcional) e invoice_items.pricing_breakdown / quantity_source (opcionales, CHECK de origen, cantidad ≥ 0)', () => {
		const item = meta(ContractItem);
		const line = meta(InvoiceItem);

		expect(item.columns.find((column) => column.databaseName === 'price_id')?.isNullable).toBe(true);
		expect(fks(item).contract_items_price_id_fkey).toEqual({ table: 'prices', onDelete: 'NO ACTION' });
		expect(indexes(item).idx_contract_items_price_id).toEqual({ columns: ['price_id'], unique: false, where: null });
		expect(line.columns.find((column) => column.databaseName === 'pricing_breakdown')).toMatchObject({ isNullable: true, type: 'jsonb' });
		expect(line.columns.find((column) => column.databaseName === 'quantity_source')).toMatchObject({ isNullable: true, type: 'text' });
		expect(line.checks.find((check) => check.name === 'invoice_items_quantity_source_check')?.expression).toContain(`'pending'::text`);
		expect(line.checks.find((check) => check.name === 'invoice_items_quantity_check')?.expression).toContain('>= (0)::numeric');
	});

	describe('migración 1790630000000-CreatePricingV2', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '1790630000000-CreatePricingV2.ts'), 'utf8');
		const up = source.slice(source.indexOf('async up('), source.indexOf('async down('));
		const down = source.slice(source.indexOf('async down('));

		it('crea las cuatro tablas con sus constraints, índices y RLS activo, en orden de dependencias', () => {
			const order = [
				'CREATE TABLE "billable_metrics"',
				'CREATE TABLE "prices"',
				'CREATE TABLE "consumption_entries"',
				'CREATE TABLE "consumption_entry_revisions"',
			];

			order.forEach((needle, index) => {
				expect(up).toContain(needle);
				if (index > 0) expect(up.indexOf(order[index - 1])).toBeLessThan(up.indexOf(needle));
			});
			for (const table of ['billable_metrics', 'prices', 'consumption_entries', 'consumption_entry_revisions']) {
				expect(up).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
				expect(up).toContain(`CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`);
			}
			expect(up).toContain('CONSTRAINT "billable_metrics_holding_id_code_key" UNIQUE ("holding_id", "code")');
			expect(up).toContain('CONSTRAINT "prices_contract_owner_check" CHECK');
			expect(up).toContain('CONSTRAINT "prices_metered_metric_check" CHECK');
			expect(up).toContain('CONSTRAINT "prices_cap_minimum_check" CHECK');
			expect(up).toContain(`"invoice_line_mode" text NOT NULL DEFAULT 'single'`);
			expect(up).toContain(`"charge_flat_when_free" boolean NOT NULL DEFAULT false`);
			expect(up).toContain(
				`CONSTRAINT "prices_invoice_line_mode_check" CHECK ("invoice_line_mode" = ANY (ARRAY['single'::text, 'per_tier'::text]))`
			);
			expect(up).toContain(
				'CONSTRAINT "consumption_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL'
			);
			expect(up).toContain(
				`CREATE INDEX "idx_consumption_entries_invoice_id" ON "consumption_entries" ("invoice_id") WHERE invoice_id IS NOT NULL`
			);
			expect(up).toContain(`CREATE INDEX "idx_prices_contract_id" ON "prices" ("contract_id") WHERE owner = 'contract'`);
			expect(up).toContain('CONSTRAINT "consumption_entries_contract_item_id_period_start_key" UNIQUE ("contract_item_id", "period_start")');
			expect(up).toContain(
				'CREATE UNIQUE INDEX "idx_consumption_entries_idempotency" ON "consumption_entries" ("holding_id", "idempotency_key") WHERE idempotency_key IS NOT NULL'
			);
			expect(up).toContain('CONSTRAINT "consumption_entry_revisions_entry_id_revision_key" UNIQUE ("entry_id", "revision")');
			expect(up).toContain('REFERENCES "contract_items"("id") ON DELETE CASCADE');
			expect(up).toContain('REFERENCES "consumption_entries"("id") ON DELETE CASCADE');
		});

		it('agrega contract_items.price_id e invoice_items.pricing_breakdown/quantity_source y relaja el CHECK de cantidad (única transición)', () => {
			expect(up).toContain('ALTER TABLE "contract_items" ADD "price_id" uuid');
			expect(up).toContain('CONSTRAINT "contract_items_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "prices"("id")');
			expect(up).toContain('CREATE INDEX "idx_contract_items_price_id"');
			expect(up).toContain('ALTER TABLE "invoice_items" ADD "pricing_breakdown" jsonb');
			expect(up).toContain('ALTER TABLE "invoice_items" ADD "quantity_source" text');
			expect(up).toContain('CONSTRAINT "invoice_items_quantity_source_check" CHECK');
			expect(up).toContain('ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_check"');
			expect(up).toContain('ADD CONSTRAINT "invoice_items_quantity_check" CHECK ((quantity >= (0)::numeric))');
			// Aditiva: ningún DROP COLUMN ni DROP TABLE en el up; el único DROP es el CHECK que se redefine.
			expect(up).not.toMatch(/DROP\s+(COLUMN|TABLE|INDEX)/);
			expect(up.match(/DROP CONSTRAINT/g)).toHaveLength(1);
		});

		it('el down deshace en orden inverso: columnas nuevas, tablas hijas antes que padres', () => {
			expect(down.indexOf('DROP COLUMN "quantity_source"')).toBeLessThan(down.indexOf('DROP COLUMN "price_id"'));
			expect(down.indexOf('DROP COLUMN "price_id"')).toBeLessThan(down.indexOf('DROP TABLE "consumption_entry_revisions"'));
			expect(down.indexOf('DROP TABLE "consumption_entry_revisions"')).toBeLessThan(down.indexOf('DROP TABLE "consumption_entries"'));
			expect(down.indexOf('DROP TABLE "consumption_entries"')).toBeLessThan(down.indexOf('DROP TABLE "prices"'));
			expect(down.indexOf('DROP TABLE "prices"')).toBeLessThan(down.indexOf('DROP TABLE "billable_metrics"'));
			expect(down).toContain('ADD CONSTRAINT "invoice_items_quantity_check" CHECK ((quantity > (0)::numeric))');
		});

		it('la clase declara el mismo name que su nombre (lo exige schema-status)', () => {
			expect(source).toContain('export class CreatePricingV21790630000000');
			expect(source).toContain(`name = 'CreatePricingV21790630000000'`);
		});
	});

	describe('assets RLS (espejo de holding_access_contract_items)', () => {
		it.each(['billable_metrics', 'prices', 'consumption_entries', 'consumption_entry_revisions'])('rls/holding_access_%s.sql', (table) => {
			const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'rls', `holding_access_${table}.sql`), 'utf8');

			expect(sql).toContain(`DROP POLICY IF EXISTS "holding_access_${table}" ON "public"."${table}";`);
			expect(sql).toContain(`CREATE POLICY "holding_access_${table}"`);
			expect(sql).toContain('FOR ALL');
			expect(sql).toContain('USING ((holding_id = get_current_user_holding_id()));');
			expect(sql).not.toMatch(/\b(ALTER|UPDATE|DELETE FROM|INSERT)\b/);
		});
	});

	it('inventario: las tablas nuevas están en espejo.existing.ts, existing-entities.json y module-map.json (contratos)', () => {
		const existing = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'espejo', 'existing-entities.json'), 'utf8')
		);
		const moduleMap = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'espejo', 'module-map.json'), 'utf8')
		);

		for (const table of ['billable_metrics', 'prices', 'consumption_entries', 'consumption_entry_revisions']) {
			expect(existing[table]?.file).toMatch(/entities\/contratos\//);
			expect(moduleMap.contratos).toContain(table);
		}
		expect(Object.values(espejoExistentes)).toEqual(expect.arrayContaining([BillableMetric, Price, ConsumptionEntry, ConsumptionEntryRevision]));
	});
});

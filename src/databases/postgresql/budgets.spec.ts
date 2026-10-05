import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata, QueryRunner } from 'typeorm';

import * as espejoExistentes from './entities/espejo.existing';
import * as espejoTodos from './entities/espejo.index';
import { BudgetLine } from './entities/revenue/budget-line.entity';
import { Budget } from './entities/revenue/budget.entity';
import { Budgets1790750000000 } from './migrations/1790750000000-Budgets';

/**
 * Presupuestos (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10: esquema"): migración escrita a mano, entities, inventarios
 * del espejo y assets (policies, triggers, índice de expresión). Sin conexión: texto de la migración y metadata en memoria. Reemplaza a la
 * migración `1790750000000-CashInGoals` (jsonb en `invoice_collection_settings`), que nunca se aplicó.
 */
const migrationSql = async (direction: 'up' | 'down', counts = { budgets: 0, lines: 0 }) => {
	const statements: string[] = [];
	const runner = {
		query: jest.fn(async (sql: string) => {
			statements.push(sql);

			return sql.includes('COUNT(*)') ? [counts] : [];
		}),
	} as unknown as QueryRunner;

	await new Budgets1790750000000()[direction](runner);

	return statements;
};

describe('migración 1790750000000-Budgets', () => {
	it('up: budgets con sus CHECK, FK al holding, índice único parcial (vivo por kind · año · escenario) y RLS', async () => {
		const sql = (await migrationSql('up')).join('\n');

		expect(sql).toContain('CREATE TABLE "budgets"');
		expect(sql).toContain(`"scenario" text NOT NULL DEFAULT 'base'`);
		expect(sql).toContain(`"period_granularity" text NOT NULL DEFAULT 'month'`);
		expect(sql).toContain(`"status" text NOT NULL DEFAULT 'active'`);
		expect(sql).toContain('"fiscal_year" smallint NOT NULL');
		expect(sql).toContain(
			`CHECK ("kind" = ANY (ARRAY['cash_in'::text, 'billing'::text, 'bookings'::text, 'mrr'::text, 'new_mrr'::text, 'expansion_mrr'::text, 'contraction_mrr'::text, 'churn_mrr'::text]))`
		);
		for (const constraint of [
			'budgets_scenario_check',
			'budgets_period_granularity_check',
			'budgets_status_check',
			'budgets_pkey',
			'budgets_holding_id_fkey',
		]) {
			expect(sql).toContain(`"${constraint}"`);
		}
		expect(sql).toContain(
			`CREATE UNIQUE INDEX "uq_budgets_holding_kind_year_scenario" ON "budgets" ("holding_id", "kind", "fiscal_year", "scenario") WHERE "status" <> 'archived'`
		);
		expect(sql).toContain('ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY');
	});

	it('up: budget_lines con dimensión (id o clave), monto ≥ 0, celda única por expresión, índices, FK en cascada y RLS; nada existente se toca', async () => {
		const sql = (await migrationSql('up')).join('\n');

		expect(sql).toContain('CREATE TABLE "budget_lines"');
		expect(sql).toContain(`"dimension_type" text NOT NULL DEFAULT 'total'`);
		expect(sql).toContain('"amount" numeric(18,2) NOT NULL');
		expect(sql).toContain(`CONSTRAINT "budget_lines_amount_check" CHECK ("amount" >= 0)`);
		expect(sql).toContain(`CONSTRAINT "budget_lines_period_start_check" CHECK (EXTRACT(DAY FROM "period_start") = 1)`);
		expect(sql).toContain('"budget_lines_dimension_check"');
		expect(sql).toContain(
			`CREATE UNIQUE INDEX "uq_budget_lines_cell" ON "budget_lines" ("budget_id", "period_start", "dimension_type", COALESCE("dimension_id", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("dimension_key", ''))`
		);
		expect(sql).toContain('CREATE INDEX "idx_budget_lines_budget" ON "budget_lines" ("budget_id")');
		expect(sql).toContain('CREATE INDEX "idx_budget_lines_holding_period" ON "budget_lines" ("holding_id", "period_start")');
		expect(sql).toContain(`REFERENCES "budgets"("id") ON DELETE CASCADE`);
		expect(sql).toContain('ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY');
		expect(sql).not.toMatch(/ALTER TABLE "(invoice_collection_settings|holding_settings|invoices)"/);
		expect(sql).not.toContain('cash_in_goals');
	});

	it('down: se niega con presupuestos cargados; sin ellos borra líneas y luego cabeceras', async () => {
		await expect(migrationSql('down', { budgets: 1, lines: 12 })).rejects.toThrow('1 presupuestos y 12 líneas');
		const sql = await migrationSql('down');

		expect(sql.slice(1)).toEqual(['DROP TABLE "budget_lines"', 'DROP TABLE "budgets"']);
	});

	it('la migración CashInGoals no existe (reemplazada antes de aplicarse)', () => {
		expect(fs.readdirSync(path.join(__dirname, 'migrations')).filter((file) => file.includes('CashInGoals'))).toEqual([]);
	});
});

describe('entities de presupuestos', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const meta = (target: unknown) => dataSource.entityMetadatas.find((entry) => entry.target === target) as EntityMetadata;

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
	});

	it('Budget: columnas, CHECK, índice único parcial y FK con los nombres de la migración', () => {
		const metadata = meta(Budget);

		expect(dataSource.isInitialized).toBe(false);
		expect(metadata.tableName).toBe('budgets');
		expect(Object.fromEntries(metadata.columns.map((column) => [column.databaseName, column.isNullable]))).toEqual({
			id: false,
			holding_id: false,
			kind: false,
			name: false,
			scenario: false,
			currency: false,
			period_granularity: false,
			fiscal_year: false,
			status: false,
			notes: true,
			created_by: true,
			created_at: false,
			updated_at: false,
		});
		expect(metadata.checks.map((check) => check.name).sort()).toEqual([
			'budgets_kind_check',
			'budgets_period_granularity_check',
			'budgets_scenario_check',
			'budgets_status_check',
		]);
		expect(metadata.indices.map((index) => [index.name, index.isUnique, index.where])).toEqual([
			['uq_budgets_holding_kind_year_scenario', true, `(status <> 'archived'::text)`],
		]);
		expect(Object.fromEntries(metadata.foreignKeys.map((fk) => [fk.name, [fk.referencedEntityMetadata.tableName, fk.onDelete]]))).toEqual({
			budgets_holding_id_fkey: ['company_holdings', 'CASCADE'],
		});
	});

	it('BudgetLine: columnas, CHECK, índices (el de celda solo avisado) y FKs en cascada', () => {
		const metadata = meta(BudgetLine);

		expect(metadata.tableName).toBe('budget_lines');
		expect(metadata.columns.find((column) => column.databaseName === 'amount')).toMatchObject({ isNullable: false, precision: 18, scale: 2 });
		expect(metadata.columns.find((column) => column.databaseName === 'dimension_id')?.isNullable).toBe(true);
		expect(metadata.columns.find((column) => column.databaseName === 'dimension_key')?.isNullable).toBe(true);
		expect(metadata.checks.map((check) => check.name).sort()).toEqual([
			'budget_lines_amount_check',
			'budget_lines_dimension_check',
			'budget_lines_dimension_type_check',
			'budget_lines_period_start_check',
		]);
		expect(metadata.indices.map((index) => [index.name, index.synchronize]).sort()).toEqual([
			['idx_budget_lines_budget', true],
			['idx_budget_lines_holding_period', true],
			['uq_budget_lines_cell', false],
		]);
		expect(Object.fromEntries(metadata.foreignKeys.map((fk) => [fk.name, [fk.referencedEntityMetadata.tableName, fk.onDelete]]))).toEqual({
			budget_lines_holding_id_fkey: ['company_holdings', 'CASCADE'],
			budget_lines_budget_id_fkey: ['budgets', 'CASCADE'],
		});
	});

	it('inventarios: espejo.existing.ts, existing-entities.json y module-map.json (revenue)', () => {
		const root = path.join(__dirname, '..', '..', '..', 'scripts', 'espejo');
		const existing = JSON.parse(fs.readFileSync(path.join(root, 'existing-entities.json'), 'utf8'));
		const moduleMap = JSON.parse(fs.readFileSync(path.join(root, 'module-map.json'), 'utf8'));

		expect(existing.budgets).toMatchObject({ class: 'Budget', file: 'src/databases/postgresql/entities/revenue/budget.entity.ts' });
		expect(existing.budget_lines).toMatchObject({ class: 'BudgetLine', file: 'src/databases/postgresql/entities/revenue/budget-line.entity.ts' });
		expect(moduleMap.revenue).toEqual(expect.arrayContaining(['budgets', 'budget_lines']));
		expect(Object.values(espejoExistentes)).toEqual(expect.arrayContaining([Budget, BudgetLine]));
	});
});

describe('assets de presupuestos', () => {
	const read = (...segments: string[]) => fs.readFileSync(path.join(__dirname, ...segments), 'utf8');

	it('4 policies por tabla (holding; las líneas además por su presupuesto) y el trigger de updated_at', () => {
		for (const [table, rule] of [
			['budgets', '(holding_id = get_current_user_holding_id())'],
			['budget_lines', '((holding_id = get_current_user_holding_id()) AND (budget_id IN ( SELECT budgets.id'],
		]) {
			for (const [operation, clause] of [
				['select', 'USING'],
				['insert', 'WITH CHECK'],
				['update', 'USING'],
				['delete', 'USING'],
			]) {
				const sql = read('rls', `tenant_isolation_${operation}_${table}.sql`);

				expect(sql).toContain(`DROP POLICY IF EXISTS "tenant_isolation_${operation}_${table}" ON "public"."${table}";`);
				expect(sql).toContain(`CREATE POLICY "tenant_isolation_${operation}_${table}"`);
				expect(sql).toContain(`FOR ${operation.toUpperCase()}`);
				expect(sql).toContain(`${clause} (${rule}`);
			}
			expect(read('triggers', `trg_${table}_updated_at.sql`)).toContain(
				`CREATE TRIGGER trg_${table}_updated_at BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
			);
		}
	});

	it('índice de celda como asset idempotente, igual al de la migración', () => {
		const sql = read('special-index', 'uq_budget_lines_cell.sql');

		expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uq_budget_lines_cell"');
		expect(sql).toContain(`COALESCE("dimension_id", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("dimension_key", '')`);
	});
});

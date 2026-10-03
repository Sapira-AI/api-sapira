import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import type { BudgetDimensionType } from '@/databases/postgresql/entities/revenue/budget-line.entity';
import type { BudgetGranularity, BudgetKind, BudgetScenario, BudgetStatus } from '@/databases/postgresql/entities/revenue/budget.entity';
import { withApiWriter } from '@/modules/contracts/api-writer';

import { type BudgetLineView, budgetMonthlyTotals, normalizeLine, round2, totalLinesOf, validateBudgetLines } from './budgets-rules';

import type { BudgetsQueryDto, UpsertBudgetDto } from './dtos/budgets.dto';

type Row = Record<string, unknown>;

export interface BudgetView {
	id: string;
	kind: BudgetKind;
	name: string;
	scenario: BudgetScenario;
	currency: string;
	period_granularity: BudgetGranularity;
	fiscal_year: number;
	status: BudgetStatus;
	notes: string | null;
	/** Total del año (líneas `total` o, sin ellas, la suma de su única dimensión). */
	total: number;
	lines_count: number;
	created_at: string | null;
	updated_at: string | null;
}

export interface BudgetDetail extends BudgetView {
	lines: BudgetLineView[];
	/** Total por mes `YYYY-MM` (los 12 meses del año fiscal). */
	monthly: Record<string, number>;
}

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value));
const dateText = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
/** Postgres 42P01 (`undefined_table`): la tabla de una migración aún no aplicada. */
export const isMissingTable = (error: unknown) => (error as { code?: string } | null)?.code === '42P01';
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === '23505';

/** Tabla del holding de cada dimensión con id (la entidad debe ser del holding; los productos globales, sin holding, también valen). */
const DIMENSION_TABLES: Partial<Record<BudgetDimensionType, { table: string; label: string; global?: boolean }>> = {
	company: { table: 'companies', label: 'compañía' },
	client: { table: 'clients', label: 'cliente' },
	seller: { table: 'sellers', label: 'vendedor' },
	product: { table: 'products', label: 'producto', global: true },
};

export const BUDGET_SELECT = `SELECT b.id, b.kind, b.name, b.scenario, b.currency, b.period_granularity, b.fiscal_year, b.status, b.notes, b.created_at, b.updated_at`;

export function mapBudgetRow(row: Row, lines: BudgetLineView[]): BudgetView {
	return {
		id: String(row.id),
		kind: String(row.kind) as BudgetKind,
		name: String(row.name),
		scenario: String(row.scenario) as BudgetScenario,
		currency: String(row.currency),
		period_granularity: String(row.period_granularity) as BudgetGranularity,
		fiscal_year: Number(row.fiscal_year),
		status: String(row.status) as BudgetStatus,
		notes: text(row.notes),
		total: round2(totalLinesOf(lines).reduce((sum, line) => sum + line.amount, 0)),
		lines_count: lines.length,
		created_at: iso(row.created_at),
		updated_at: iso(row.updated_at),
	};
}

export const mapLineRow = (row: Row): BudgetLineView => ({
	period_start: dateText(row.period_start),
	dimension_type: String(row.dimension_type) as BudgetDimensionType,
	dimension_id: text(row.dimension_id),
	dimension_key: text(row.dimension_key),
	amount: Number(row.amount),
});

/**
 * Presupuestos genéricos por holding (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10"; tablas `budgets` + `budget_lines`,
 * migración `1790750000000-Budgets`). Un presupuesto vivo por (kind, año fiscal, escenario); el PUT reemplaza todas sus líneas en una
 * transacción. Montos en la moneda de sistema del holding. Lo usan la meta de cobranza (`kind = cash_in`) y la proyección de cobros.
 */
@Injectable()
export class BudgetsService {
	constructor(private readonly dataSource: DataSource) {}

	async systemCurrency(holdingId: string): Promise<string> {
		const [row] = (await this.dataSource.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [
			holdingId,
		])) as Row[];

		return text(row?.system_currency)?.toUpperCase() ?? 'USD';
	}

	private async linesOf(holdingId: string, budgetIds: string[]): Promise<Map<string, BudgetLineView[]>> {
		const result = new Map<string, BudgetLineView[]>(budgetIds.map((id) => [id, []]));

		if (!budgetIds.length) return result;
		const rows = (await this.dataSource.query(
			`SELECT budget_id, period_start::text AS period_start, dimension_type, dimension_id, dimension_key, amount
			FROM budget_lines WHERE holding_id = $1 AND budget_id = ANY($2::uuid[])
			ORDER BY period_start, dimension_type, dimension_key NULLS FIRST, dimension_id NULLS FIRST`,
			[holdingId, budgetIds]
		)) as Row[];

		for (const row of rows) result.get(String(row.budget_id))?.push(mapLineRow(row));

		return result;
	}

	/** `GET /budgets`: presupuestos del holding (sin archivados), con su total y conteo de líneas. */
	async list(holdingId: string, query: BudgetsQueryDto): Promise<BudgetView[]> {
		const params: unknown[] = [holdingId];
		const conditions = ['b.holding_id = $1', `b.status <> 'archived'`];

		if (query.kind) conditions.push(`b.kind = $${params.push(query.kind)}`);
		if (query.fiscal_year) conditions.push(`b.fiscal_year = $${params.push(query.fiscal_year)}`);
		const rows = (await this.dataSource.query(
			`${BUDGET_SELECT} FROM budgets b WHERE ${conditions.join(' AND ')} ORDER BY b.fiscal_year DESC, b.kind, b.scenario`,
			params
		)) as Row[];
		const lines = await this.linesOf(
			holdingId,
			rows.map((row) => String(row.id))
		);

		return rows.map((row) => mapBudgetRow(row, lines.get(String(row.id)) ?? []));
	}

	/** `GET /budgets/:id`: el presupuesto con sus líneas y el total por mes. 404 si no es del holding. */
	async get(holdingId: string, id: string): Promise<BudgetDetail> {
		const [row] = (await this.dataSource.query(`${BUDGET_SELECT} FROM budgets b WHERE b.holding_id = $1 AND b.id = $2`, [
			holdingId,
			id,
		])) as Row[];

		if (!row) throw new NotFoundException('El presupuesto no existe en este holding');

		return this.detailOf(row, (await this.linesOf(holdingId, [id])).get(id) ?? []);
	}

	private detailOf(row: Row, lines: BudgetLineView[]): BudgetDetail {
		const view = mapBudgetRow(row, lines);

		return { ...view, lines, monthly: budgetMonthlyTotals(lines, view.period_granularity, view.fiscal_year) };
	}

	/**
	 * Presupuestos **activos** de un kind para varios años (escenario `base` por defecto), con líneas. Sin la tabla (migración sin aplicar)
	 * responde vacío: los reportes muestran "sin presupuesto" en vez de fallar.
	 */
	async activeFor(holdingId: string, kind: BudgetKind, years: number[], scenario: BudgetScenario = 'base'): Promise<BudgetDetail[]> {
		if (!years.length) return [];
		try {
			const rows = (await this.dataSource.query(
				`${BUDGET_SELECT} FROM budgets b
				WHERE b.holding_id = $1 AND b.kind = $2 AND b.scenario = $3 AND b.status = 'active' AND b.fiscal_year = ANY($4::int[])
				ORDER BY b.fiscal_year`,
				[holdingId, kind, scenario, years]
			)) as Row[];
			const lines = await this.linesOf(
				holdingId,
				rows.map((row) => String(row.id))
			);

			return rows.map((row) => this.detailOf(row, lines.get(String(row.id)) ?? []));
		} catch (error) {
			if (isMissingTable(error)) return [];
			throw error;
		}
	}

	/** Las entidades de las líneas (compañía, cliente, vendedor, producto) deben ser del holding. */
	private async assertDimensions(holdingId: string, lines: BudgetLineView[]): Promise<void> {
		for (const [type, config] of Object.entries(DIMENSION_TABLES) as Array<
			[BudgetDimensionType, { table: string; label: string; global?: boolean }]
		>) {
			const ids = [
				...new Set(lines.filter((line) => line.dimension_type === type && line.dimension_id).map((line) => line.dimension_id as string)),
			];

			if (!ids.length) continue;
			const rows = (await this.dataSource.query(
				`SELECT id FROM ${config.table} WHERE id = ANY($2::uuid[]) AND (holding_id = $1${config.global ? ' OR holding_id IS NULL' : ''})`,
				[holdingId, ids]
			)) as Row[];
			const found = new Set(rows.map((row) => String(row.id)));
			const missing = ids.filter((id) => !found.has(id));

			if (missing.length) {
				throw validationException(missing.map((id) => ({ field: 'lines', message: `La ${config.label} ${id} no existe en este holding` })));
			}
		}
	}

	/**
	 * `PUT /budgets`: crea o reemplaza el presupuesto vivo (no archivado) de (kind, fiscal_year, scenario): actualiza la cabecera y reemplaza
	 * **todas** las líneas en una transacción. Moneda = la de sistema del holding. 400 con `errors[]` si las líneas no cumplen las reglas.
	 */
	async upsert(holdingId: string, dto: UpsertBudgetDto, authId: string | null): Promise<BudgetDetail> {
		const granularity = dto.period_granularity ?? 'month';
		const scenario = dto.scenario ?? 'base';
		const lines = dto.lines.map(normalizeLine);
		const errors = validateBudgetLines({ granularity, fiscalYear: dto.fiscal_year, lines });

		if (errors.length) throw validationException(errors);
		await this.assertDimensions(holdingId, lines);
		const currency = await this.systemCurrency(holdingId);
		let budgetId: string;

		try {
			budgetId = await withApiWriter(this.dataSource, async (runner) => {
				const [user] = authId ? ((await runner.query(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [authId])) as Row[]) : [];
				const [existing] = (await runner.query(
					`SELECT id FROM budgets WHERE holding_id = $1 AND kind = $2 AND fiscal_year = $3 AND scenario = $4 AND status <> 'archived' FOR UPDATE`,
					[holdingId, dto.kind, dto.fiscal_year, scenario]
				)) as Row[];
				let id: string;

				if (existing) {
					id = String(existing.id);
					await runner.query(
						`UPDATE budgets SET name = $3, currency = $4, period_granularity = $5, status = $6, notes = $7, updated_at = now()
						WHERE holding_id = $1 AND id = $2`,
						[holdingId, id, dto.name, currency, granularity, dto.status ?? 'active', dto.notes ?? null]
					);
					await runner.query(`DELETE FROM budget_lines WHERE holding_id = $1 AND budget_id = $2`, [holdingId, id]);
				} else {
					const [created] = (await runner.query(
						`INSERT INTO budgets (holding_id, kind, name, scenario, currency, period_granularity, fiscal_year, status, notes, created_by)
						VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
						[
							holdingId,
							dto.kind,
							dto.name,
							scenario,
							currency,
							granularity,
							dto.fiscal_year,
							dto.status ?? 'active',
							dto.notes ?? null,
							user?.id ?? null,
						]
					)) as Row[];

					id = String(created.id);
				}
				if (lines.length) {
					await runner.query(
						`INSERT INTO budget_lines (holding_id, budget_id, period_start, dimension_type, dimension_id, dimension_key, amount)
						SELECT $1, $2, x.period_start, x.dimension_type, x.dimension_id, x.dimension_key, x.amount
						FROM unnest($3::date[], $4::text[], $5::uuid[], $6::text[], $7::numeric[]) AS x(period_start, dimension_type, dimension_id, dimension_key, amount)`,
						[
							holdingId,
							id,
							lines.map((line) => line.period_start),
							lines.map((line) => line.dimension_type),
							lines.map((line) => line.dimension_id),
							lines.map((line) => line.dimension_key),
							lines.map((line) => line.amount),
						]
					);
				}

				return id;
			});
		} catch (error) {
			if (isMissingTable(error)) {
				throw new ConflictException({
					message: 'Los presupuestos aún no se pueden guardar: falta aplicar la migración 1790750000000-Budgets',
					code: 'budget_storage_missing',
				});
			}
			if (isUniqueViolation(error)) {
				throw new ConflictException({
					message: 'Otro usuario guardó este presupuesto al mismo tiempo; vuelve a intentarlo',
					code: 'budget_conflict',
				});
			}
			throw error;
		}

		return await this.get(holdingId, budgetId);
	}

	/** `POST /budgets/:id/archive`: lo archiva (libera el lugar de su kind · año · escenario). Idempotente; 404 si no es del holding. */
	async archive(holdingId: string, id: string): Promise<BudgetDetail> {
		const rows = (await withApiWriter(this.dataSource, async (runner) =>
			runner.query(`UPDATE budgets SET status = 'archived', updated_at = now() WHERE holding_id = $1 AND id = $2 RETURNING id`, [holdingId, id])
		)) as Row[];

		if (!rows.length) throw new NotFoundException('El presupuesto no existe en este holding');

		return await this.get(holdingId, id);
	}

	/** Archiva el presupuesto vivo de (kind, año, escenario), si existe (la meta de cobranza "Quitar presupuesto"). */
	async archiveFor(holdingId: string, kind: BudgetKind, fiscalYear: number, scenario: BudgetScenario = 'base'): Promise<void> {
		try {
			await withApiWriter(this.dataSource, async (runner) =>
				runner.query(
					`UPDATE budgets SET status = 'archived', updated_at = now()
					WHERE holding_id = $1 AND kind = $2 AND fiscal_year = $3 AND scenario = $4 AND status <> 'archived'`,
					[holdingId, kind, fiscalYear, scenario]
				)
			);
		} catch (error) {
			if (isMissingTable(error)) return;
			throw error;
		}
	}
}

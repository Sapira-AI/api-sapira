/**
 * Reglas puras de Presupuestos (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10"): validación de líneas, total por mes y
 * alineación con los períodos de un reporte (mes, semana o día). Fechas como texto `YYYY-MM-DD` con aritmética UTC.
 *
 * - **Total del presupuesto**: las líneas `total`; sin ellas, la suma de las líneas de su única dimensión (dos dimensiones sin total = 400).
 * - **Reparto por dimensión**: con línea `total` en el período, las líneas de cada dimensión deben sumar ese total (±0,01).
 * - **Por mes**: granularidad `month` = la línea del mes; `quarter` = trimestre ÷ 3; `year` = año ÷ 12 (el residuo del redondeo va al último
 *   mes, así la suma cuadra con el total).
 * - **Por período del reporte**: mes = el monto del mes; semana o día = prorrateo por días del mes que cubre (un mes sin presupuesto no suma;
 *   un período sin ningún mes cubierto = `null`).
 */
import {
	BUDGET_DIMENSION_TYPES,
	BUDGET_ID_DIMENSIONS,
	BUDGET_KEY_DIMENSIONS,
	type BudgetDimensionType,
} from '@/databases/postgresql/entities/revenue/budget-line.entity';
import type { BudgetGranularity } from '@/databases/postgresql/entities/revenue/budget.entity';

export interface BudgetLineInput {
	period_start: string;
	dimension_type?: BudgetDimensionType | null;
	dimension_id?: string | null;
	dimension_key?: string | null;
	amount: number;
}

export interface BudgetLineView {
	period_start: string;
	dimension_type: BudgetDimensionType;
	dimension_id: string | null;
	dimension_key: string | null;
	amount: number;
}

export interface FieldError {
	field: string;
	message: string;
}

/** Período de un reporte (`CalendarPeriod` de billing): clave, inicio y fin `YYYY-MM-DD`. */
export interface ReportPeriod {
	key: string;
	start: string;
	end: string;
}

export const BUDGET_LINES_MAX = 5000;
export const BUDGET_AMOUNT_MAX = 1e15;
export const BUDGET_KEY_MAX = 120;
const TOLERANCE = 0.01;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const pad = (value: number) => String(value).padStart(2, '0');
const toTime = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const twoDecimals = (value: number) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/** Primer día de cada período del año fiscal según la granularidad (12 meses, 4 trimestres o el año). */
export function budgetPeriodStarts(granularity: BudgetGranularity, fiscalYear: number): string[] {
	const months = granularity === 'month' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : granularity === 'quarter' ? [1, 4, 7, 10] : [1];

	return months.map((month) => `${fiscalYear}-${pad(month)}-01`);
}

/** Meses `YYYY-MM` que cubre la línea que empieza en `periodStart` con esa granularidad. */
export function monthsOfPeriod(periodStart: string, granularity: BudgetGranularity): string[] {
	const year = Number(periodStart.slice(0, 4));
	const first = Number(periodStart.slice(5, 7));
	const count = granularity === 'month' ? 1 : granularity === 'quarter' ? 3 : 12;

	return Array.from({ length: count }, (_, index) => `${year}-${pad(first + index)}`);
}

/** Reparte `amount` en `parts` partes de 2 decimales; el residuo del redondeo va a la última (la suma cuadra). */
export function splitEven(amount: number, parts: number): number[] {
	if (parts <= 0) return [];
	const base = Math.floor((amount / parts) * 100) / 100;
	const values = Array.from({ length: parts }, () => base);

	values[parts - 1] = round2(amount - base * (parts - 1));

	return values;
}

/** Reparte `amount` según `weights` (2 decimales, residuo a la última parte con peso); sin pesos, partes iguales. */
export function splitWeighted(amount: number, weights: number[]): number[] {
	const total = weights.reduce((sum, weight) => sum + weight, 0);

	if (!(total > 0)) return splitEven(amount, weights.length);
	const values = weights.map((weight) => Math.floor(((amount * weight) / total) * 100) / 100);
	const last = weights.map((weight) => weight > 0).lastIndexOf(true);

	values[last] = round2(values[last] + amount - values.reduce((sum, value) => sum + value, 0));

	return values;
}

const cellKey = (line: BudgetLineView) => `${line.period_start}|${line.dimension_type}|${line.dimension_id ?? ''}|${line.dimension_key ?? ''}`;

/** Normaliza una línea de entrada (dimensión por defecto `total`, clave sin espacios, monto a 2 decimales). */
export function normalizeLine(line: BudgetLineInput): BudgetLineView {
	const key = typeof line.dimension_key === 'string' ? line.dimension_key.trim() : null;

	return {
		period_start: line.period_start,
		dimension_type: line.dimension_type ?? 'total',
		dimension_id: line.dimension_id ? line.dimension_id.toLowerCase() : null,
		dimension_key: key ? key : null,
		amount: Number(line.amount),
	};
}

/**
 * Valida las líneas de un presupuesto contra su granularidad y año (ver encabezado). Devuelve `errors[{ field, message }]` (vacío = ok);
 * `field` = `lines[i].<campo>` o `lines` para las reglas del conjunto.
 */
export function validateBudgetLines({
	granularity,
	fiscalYear,
	lines,
}: {
	granularity: BudgetGranularity;
	fiscalYear: number;
	lines: BudgetLineView[];
}): FieldError[] {
	const errors: FieldError[] = [];
	const starts = new Set(budgetPeriodStarts(granularity, fiscalYear));
	const seen = new Set<string>();

	if (lines.length > BUDGET_LINES_MAX) return [{ field: 'lines', message: `Un presupuesto admite hasta ${BUDGET_LINES_MAX} líneas` }];
	lines.forEach((line, index) => {
		const at = (field: string, message: string) => errors.push({ field: `lines[${index}].${field}`, message });

		if (!Number.isFinite(line.amount) || line.amount < 0) at('amount', 'El monto debe ser un número mayor o igual a 0');
		else if (line.amount > BUDGET_AMOUNT_MAX) at('amount', 'Monto inválido');
		else if (!twoDecimals(line.amount)) at('amount', 'El monto admite hasta 2 decimales');
		if (!ISO_DATE.test(line.period_start ?? '')) at('period_start', 'El período debe ser una fecha YYYY-MM-DD');
		else if (!starts.has(line.period_start)) {
			at(
				'period_start',
				granularity === 'month'
					? `El período debe ser el primer día de un mes de ${fiscalYear}`
					: granularity === 'quarter'
						? `El período debe ser el primer día de un trimestre de ${fiscalYear} (ene, abr, jul u oct)`
						: `El período de un presupuesto anual es ${fiscalYear}-01-01`
			);
		}
		if (!(BUDGET_DIMENSION_TYPES as readonly string[]).includes(line.dimension_type)) at('dimension_type', 'Dimensión inválida');
		else if (line.dimension_type === 'total') {
			if (line.dimension_id || line.dimension_key) at('dimension_type', 'Una línea total no lleva entidad ni clave');
		} else if ((BUDGET_ID_DIMENSIONS as readonly string[]).includes(line.dimension_type)) {
			if (!line.dimension_id || !UUID.test(line.dimension_id)) at('dimension_id', 'Indica la entidad (UUID) de la línea');
			if (line.dimension_key) at('dimension_key', 'Esta dimensión se identifica por id, no por clave');
		} else if ((BUDGET_KEY_DIMENSIONS as readonly string[]).includes(line.dimension_type)) {
			if (!line.dimension_key) at('dimension_key', 'Indica el segmento o mercado de la línea');
			else if (line.dimension_key.length > BUDGET_KEY_MAX) at('dimension_key', `La clave admite hasta ${BUDGET_KEY_MAX} caracteres`);
			if (line.dimension_id) at('dimension_id', 'Esta dimensión se identifica por clave, no por id');
		}
		const key = cellKey(line);

		if (seen.has(key)) at('period_start', 'Celda repetida (mismo período y dimensión)');
		seen.add(key);
	});
	if (errors.length) return errors;

	const totals = new Map(lines.filter((line) => line.dimension_type === 'total').map((line) => [line.period_start, line.amount]));
	const dimensionTypes = [...new Set(lines.filter((line) => line.dimension_type !== 'total').map((line) => line.dimension_type))];

	if (!totals.size && dimensionTypes.length > 1) {
		return [{ field: 'lines', message: 'Sin líneas total, todas las líneas deben ser de una sola dimensión' }];
	}
	if (totals.size) {
		for (const type of dimensionTypes) {
			const byPeriod = new Map<string, number>();

			for (const line of lines.filter((entry) => entry.dimension_type === type)) {
				byPeriod.set(line.period_start, (byPeriod.get(line.period_start) ?? 0) + line.amount);
			}
			for (const [period, sum] of byPeriod) {
				const total = totals.get(period);

				if (total === undefined) errors.push({ field: 'lines', message: `El reparto por ${type} de ${period} no tiene línea total` });
				else if (Math.abs(round2(sum) - total) > TOLERANCE) {
					errors.push({ field: 'lines', message: `El reparto por ${type} de ${period} suma ${round2(sum)} y el total es ${total}` });
				}
			}
		}
	}

	return errors;
}

/** Líneas que definen el total: las `total` o, sin ellas, las de la única dimensión. */
export function totalLinesOf(lines: BudgetLineView[]): BudgetLineView[] {
	const totals = lines.filter((line) => line.dimension_type === 'total');

	return totals.length ? totals : lines;
}

/**
 * Monto por mes `YYYY-MM` de un conjunto de líneas (trimestre ÷ 3, año ÷ 12, residuo al último mes). Con `fiscalYear`, los 12 meses del año
 * quedan cubiertos (un mes sin línea = 0: el presupuesto existe y ese mes no espera nada).
 */
export function monthlyAmounts(lines: BudgetLineView[], granularity: BudgetGranularity, fiscalYear?: number): Record<string, number> {
	const result: Record<string, number> = fiscalYear
		? Object.fromEntries(monthsOfPeriod(`${fiscalYear}-01-01`, 'year').map((month) => [month, 0]))
		: {};

	for (const line of lines) {
		const months = monthsOfPeriod(line.period_start, granularity);

		splitEven(line.amount, months.length).forEach((value, index) => {
			result[months[index]] = round2((result[months[index]] ?? 0) + value);
		});
	}

	return result;
}

/** Monto por mes del total del presupuesto (los 12 meses del año fiscal). */
export const budgetMonthlyTotals = (lines: BudgetLineView[], granularity: BudgetGranularity, fiscalYear: number) =>
	monthlyAmounts(totalLinesOf(lines), granularity, fiscalYear);

/** Monto por mes de cada entidad de una dimensión (`dimension_id` o `dimension_key`). */
export function budgetMonthlyByDimension(
	lines: BudgetLineView[],
	granularity: BudgetGranularity,
	type: BudgetDimensionType,
	fiscalYear?: number
): Map<string, Record<string, number>> {
	const groups = new Map<string, BudgetLineView[]>();

	for (const line of lines.filter((entry) => entry.dimension_type === type)) {
		const key = line.dimension_id ?? line.dimension_key ?? '';

		groups.set(key, [...(groups.get(key) ?? []), line]);
	}

	return new Map([...groups].map(([key, group]) => [key, monthlyAmounts(group, granularity, fiscalYear)]));
}

/**
 * Presupuesto de cada período del reporte desde el monto por mes: mes = el del mes; semana/día = prorrateo por días de cada mes que toca.
 * Meses sin presupuesto no suman; un período sin ningún mes con presupuesto = `null`.
 */
export function alignToPeriods(monthly: Record<string, number>, periods: ReportPeriod[]): Record<string, number | null> {
	const result: Record<string, number | null> = {};

	for (const period of periods) {
		let amount = 0;
		let covered = false;
		let cursor = toTime(period.start);
		const end = toTime(period.end);

		while (cursor <= end) {
			const date = new Date(cursor);
			const month = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
			const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
			const until = Math.min(end, monthEnd);
			const days = Math.round((until - cursor) / DAY_MS) + 1;

			if (monthly[month] !== undefined) {
				covered = true;
				amount += (monthly[month] * days) / daysInMonth(month);
			}
			cursor = until + DAY_MS;
		}
		result[period.key] = covered ? round2(amount) : null;
	}

	return result;
}

/**
 * Calendario de facturación (`GET /billing/calendar`, spec-facturacion-v2 §4.1/§4.2): filas = clientes (o contratos), columnas = meses,
 * semanas (lunes a domingo) o días, celdas = facturas con monto por moneda (nunca se suman monedas), conteo por estado y las primeras facturas
 * para abrirlas. Totales por columna y por fila, por moneda y en moneda de sistema. Funciones puras: fechas como texto `YYYY-MM-DD` con
 * aritmética UTC (sin `toISOString()` sobre fechas locales).
 */

export const CALENDAR_GRANULARITIES = ['month', 'week', 'day'] as const;
export type CalendarGranularity = (typeof CALENDAR_GRANULARITIES)[number];

export const CALENDAR_SCOPES = ['invoices', 'to_issue'] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

export const CALENDAR_GROUP_BY = ['client', 'contract'] as const;
export type CalendarGroupBy = (typeof CALENDAR_GROUP_BY)[number];

/** Columnas por defecto y tope por granularidad (el rango se acota a esto: más columnas = 400). */
export const CALENDAR_DEFAULT_PERIODS: Record<CalendarGranularity, number> = { month: 12, week: 12, day: 21 };
export const CALENDAR_MAX_PERIODS: Record<CalendarGranularity, number> = { month: 24, week: 26, day: 62 };
/** Facturas por celda que viajan con detalle (el resto solo suma al conteo). */
export const CALENDAR_CELL_ITEMS = 20;
/** Tope de facturas que el calendario agrega en memoria; por encima, `truncated: true`. */
export const CALENDAR_MAX_ROWS = 20000;
/** Columna de las Por Emitir con fecha anterior al rango (atrasadas que siguen en la cola, solo `scope=to_issue`). */
export const BEFORE_KEY = 'before';

/**
 * Estado de la factura en el calendario. `scope=invoices`: `to_issue` · `issued` · `overdue` · `paid` · `credit_note` · `cancelled`.
 * `scope=to_issue`: el grupo de la cola (`ready` · `blocked` · `late` · `erp_draft`).
 */
export type CalendarState = string;

export interface CalendarPeriod {
	key: string;
	start: string;
	end: string;
	/** `before` = columna de atrasadas (fuera del rango, solo en la cola). */
	kind?: 'before';
}

export interface CalendarInvoiceRow {
	id: string;
	invoice_number: string | null;
	client_id: string | null;
	client_name: string | null;
	contract_id: string | null;
	contract_number: string | null;
	date: string;
	/**
	 * Moneda en la que cuenta (ver `calendarAmountOf`): la de la factura si está emitida; la del **contrato** si no (Por Emitir), que suma a la
	 * fila "Total UF" de esa moneda.
	 */
	currency: string | null;
	/** Total en `currency` (`null` = sin monto conocido: cuenta la factura, no suma). */
	amount: number | null;
	/** Total en moneda de sistema (`null` = sin conversión: no suma al total del sistema). */
	amount_system: number | null;
	state: CalendarState;
	/** No emitida que cuenta en la moneda del contrato, distinta de la de la factura (se valoriza al emitir). */
	in_contract_currency?: boolean;
	/** Moneda de la factura (cuando `currency` es la del contrato). */
	invoice_currency?: string | null;
}

export interface CurrencyAmount {
	currency: string;
	amount: number;
	invoices: number;
}

export interface CalendarTotals {
	invoices: number;
	/** Por moneda en la que cuenta cada factura: la de la factura (emitida) o la del contrato (no emitida). */
	by_currency: CurrencyAmount[];
	/** Suma en moneda de sistema de las que tienen monto en sistema. */
	system: number;
	/** Facturas sin monto en moneda de sistema (no suman a `system`). */
	unconverted: number;
	/** No emitidas que cuentan en la moneda del contrato, distinta de la de la factura (aviso "se valoriza al emitir"). */
	in_contract_currency: number;
	by_state: Record<string, number>;
}

export interface CalendarCell extends CalendarTotals {
	items: Array<{
		id: string;
		invoice_number: string | null;
		state: string;
		currency: string | null;
		amount: number | null;
		contract_id: string | null;
		date: string;
		/** No emitida en la moneda del contrato (distinta de la de la factura). */
		in_contract_currency?: boolean;
		invoice_currency?: string | null;
	}>;
}

export interface CalendarRowGroup {
	key: string;
	client_id: string | null;
	client_name: string | null;
	contract_id: string | null;
	contract_number: string | null;
	cells: Record<string, CalendarCell>;
	totals: CalendarTotals;
}

const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const toTime = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const fromTime = (time: number) => {
	const date = new Date(time);

	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

export const addDays = (date: string, days: number) => fromTime(toTime(date) + days * DAY_MS);

/** Lunes de la semana de una fecha. */
export const mondayOf = (date: string) => addDays(date, -((new Date(toTime(date)).getUTCDay() + 6) % 7));

const monthEnd = (month: string) => {
	const year = Number(month.slice(0, 4));
	const index = Number(month.slice(5, 7));

	return addDays(index === 12 ? `${year + 1}-01-01` : `${year}-${pad(index + 1)}-01`, -1);
};

const nextMonth = (month: string) => {
	const year = Number(month.slice(0, 4));
	const index = Number(month.slice(5, 7));

	return index === 12 ? `${year + 1}-01` : `${year}-${pad(index + 1)}`;
};

/** Clave de la columna de una fecha: `YYYY-MM` (mes), lunes `YYYY-MM-DD` (semana) o la fecha (día). */
export function periodKeyOf(date: string, granularity: CalendarGranularity): string {
	if (granularity === 'month') return date.slice(0, 7);
	if (granularity === 'week') return mondayOf(date);

	return date.slice(0, 10);
}

/** Columna que empieza en `key`. */
export function periodOf(key: string, granularity: CalendarGranularity): CalendarPeriod {
	if (granularity === 'month') return { key, start: `${key}-01`, end: monthEnd(key) };
	if (granularity === 'week') return { key, start: key, end: addDays(key, 6) };

	return { key, start: key, end: key };
}

const nextKey = (key: string, granularity: CalendarGranularity) =>
	granularity === 'month' ? nextMonth(key) : addDays(key, granularity === 'week' ? 7 : 1);

/**
 * Columnas del rango: desde la columna que contiene `start` hasta la que contiene `end` (o `CALENDAR_DEFAULT_PERIODS`). Lanza
 * `RangeError` si el rango es inverso o supera `CALENDAR_MAX_PERIODS`.
 */
export function calendarPeriods(start: string, end: string | null | undefined, granularity: CalendarGranularity): CalendarPeriod[] {
	const first = periodKeyOf(start, granularity);
	const last = end ? periodKeyOf(end, granularity) : null;

	if (last && last < first) throw new RangeError('El fin del calendario es anterior al inicio');
	const periods: CalendarPeriod[] = [];
	let key = first;

	for (;;) {
		periods.push(periodOf(key, granularity));
		if (last ? key >= last : periods.length >= CALENDAR_DEFAULT_PERIODS[granularity]) break;
		if (periods.length >= CALENDAR_MAX_PERIODS[granularity]) {
			throw new RangeError(`El calendario admite hasta ${CALENDAR_MAX_PERIODS[granularity]} columnas en esta granularidad`);
		}
		key = nextKey(key, granularity);
	}

	return periods;
}

/** Estado de una factura en el calendario de todas las facturas (gemelo de lo que muestra la lista). */
export function calendarStateOf(row: {
	status: string | null;
	document_kind: string | null;
	payment_state: string | null;
	is_overdue: boolean;
}): CalendarState {
	if (row.status === 'Cancelada') return 'cancelled';
	if (row.document_kind && row.document_kind !== 'invoice') return 'credit_note';
	if (row.status === 'Por Emitir') return 'to_issue';
	if (row.payment_state === 'paid') return 'paid';
	if (row.is_overdue) return 'overdue';

	return 'issued';
}

const emptyTotals = (): CalendarTotals => ({ invoices: 0, by_currency: [], system: 0, unconverted: 0, in_contract_currency: 0, by_state: {} });

function addAmount(list: CurrencyAmount[], currency: string, amount: number | null) {
	let entry = list.find((item) => item.currency === currency);

	if (!entry) {
		entry = { currency, amount: 0, invoices: 0 };
		list.push(entry);
		list.sort((a, b) => a.currency.localeCompare(b.currency));
	}
	entry.invoices += 1;
	if (amount !== null) entry.amount = round2(entry.amount + amount);
}

/**
 * Moneda y monto con que cuenta una factura en el calendario (regla 02-10): **emitida** ⇒ su moneda y su total (si difiere del contrato,
 * siempre tiene su tipo de cambio); **no emitida** (Por Emitir) ⇒ la moneda del **contrato** y su total en ella (neto + IVA convertido; sin
 * tipo de cambio todavía, el neto), así suma a la fila "Total UF" de esa moneda en vez de quedar "sin valorizar".
 */
export function calendarAmountOf(row: {
	status: string | null;
	invoice_currency: string | null;
	total_due: number | null;
	contract_currency: string | null;
	amount_contract: number | null;
	total_contract: number | null;
}): { currency: string | null; amount: number | null; in_contract_currency: boolean } {
	const invoiceCurrency = row.invoice_currency?.toUpperCase() ?? null;
	const contractCurrency = row.contract_currency?.toUpperCase() ?? null;

	if (row.status !== 'Por Emitir' || !contractCurrency || contractCurrency === invoiceCurrency) {
		return {
			currency: invoiceCurrency ?? contractCurrency,
			amount: row.total_due ?? (row.status === 'Por Emitir' ? row.amount_contract : null),
			in_contract_currency: false,
		};
	}

	return { currency: contractCurrency, amount: row.total_contract ?? row.amount_contract, in_contract_currency: true };
}

function addTo(target: CalendarTotals, row: CalendarInvoiceRow) {
	target.invoices += 1;
	target.by_state[row.state] = (target.by_state[row.state] ?? 0) + 1;
	if (row.in_contract_currency) target.in_contract_currency += 1;
	addAmount(target.by_currency, (row.currency ?? '—').toUpperCase(), row.amount);
	if (row.amount_system === null) target.unconverted += 1;
	else target.system = round2(target.system + row.amount_system);
}

/**
 * Agrega las facturas en filas × columnas. Con `rangeStart`, las de fecha anterior caen en la columna `before` (se antepone si hay alguna);
 * las de fecha posterior al rango se ignoran. Filas ordenadas por nombre (cliente y luego contrato).
 */
export function buildCalendar(
	rows: CalendarInvoiceRow[],
	periods: CalendarPeriod[],
	{ granularity, groupBy }: { granularity: CalendarGranularity; groupBy: CalendarGroupBy }
) {
	const rangeStart = periods[0]?.start ?? '';
	const rangeEnd = periods[periods.length - 1]?.end ?? '';
	const keys = new Set(periods.map((period) => period.key));
	const groups = new Map<string, CalendarRowGroup>();
	const columnTotals: Record<string, CalendarTotals> = {};
	const grand = emptyTotals();
	let hasBefore = false;

	for (const row of rows) {
		const date = row.date.slice(0, 10);

		if (date > rangeEnd) continue;
		const key = date < rangeStart ? BEFORE_KEY : periodKeyOf(date, granularity);

		if (key !== BEFORE_KEY && !keys.has(key)) continue;
		if (key === BEFORE_KEY) hasBefore = true;
		const groupKey = groupBy === 'contract' ? (row.contract_id ?? `sin-contrato:${row.client_id ?? 'none'}`) : (row.client_id ?? 'none');
		const group = groups.get(groupKey) ?? {
			key: groupKey,
			client_id: row.client_id,
			client_name: row.client_name,
			contract_id: groupBy === 'contract' ? row.contract_id : null,
			contract_number: groupBy === 'contract' ? row.contract_number : null,
			cells: {},
			totals: emptyTotals(),
		};
		const cell = group.cells[key] ?? { ...emptyTotals(), items: [] };

		addTo(cell, row);
		if (cell.items.length < CALENDAR_CELL_ITEMS) {
			cell.items.push({
				id: row.id,
				invoice_number: row.invoice_number,
				state: row.state,
				currency: row.currency,
				amount: row.amount,
				contract_id: row.contract_id,
				date,
				...(row.in_contract_currency ? { in_contract_currency: true, invoice_currency: row.invoice_currency ?? null } : {}),
			});
		}
		group.cells[key] = cell;
		addTo(group.totals, row);
		columnTotals[key] = columnTotals[key] ?? emptyTotals();
		addTo(columnTotals[key], row);
		addTo(grand, row);
		groups.set(groupKey, group);
	}
	const beforePeriod: CalendarPeriod = { key: BEFORE_KEY, start: '', end: addDays(rangeStart, -1), kind: 'before' };

	return {
		periods: hasBefore ? [beforePeriod, ...periods] : periods,
		rows: [...groups.values()].sort(
			(a, b) =>
				(a.client_name ?? '￿').localeCompare(b.client_name ?? '￿', 'es') ||
				(a.contract_number ?? '￿').localeCompare(b.contract_number ?? '￿', 'es') ||
				a.key.localeCompare(b.key)
		),
		totals: columnTotals,
		grand_total: grand,
	};
}

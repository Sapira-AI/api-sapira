/**
 * Proyección de cobros y meta anual de cobranza (Cobranza › Cuentas por cobrar, spec-facturacion-v2 §4.5; port del "Proyección de cobros" de
 * `ARAgingReport` del front anterior). Funciones puras sobre las filas de la antigüedad (saldo al corte por factura):
 *
 * - **Proyección**: el saldo abierto cae en la columna de su **vencimiento** (mes, semana o día); lo vencido al corte va en **Vencido por
 *   cobrar**, lo que no tiene vencimiento aparte y lo que vence después del rango en **Posteriores** (el total siempre cuadra). Montos en
 *   moneda de sistema (lo único sumable entre monedas) y por moneda de factura en cada columna. Las facturas CLF/UF no entran (datos por revisar).
 * - **Presupuesto de ingresos a caja** (antes "meta"; presupuesto `cash_in` de `budgets`, decisión 02-10): presupuesto por mes vs cobrado
 *   del año (pagos monetarios) vs proyectado (cobrado + saldo que vence dentro del año, lo vencido incluido), % de cumplimiento anual, por
 *   mes y a la fecha (YTD). En la proyección, presupuesto vs cobrado vs proyectado por período (`buildForecastBudget`).
 *
 * El comportamiento de pago por cliente (`avg_days_to_pay`, `avg_days_late`) se expone tal cual para Insights; no ajusta la proyección.
 */
import { type CalendarGranularity, type CalendarPeriod, periodKeyOf } from './billing-calendar';
import { type AgingRow, isNonInvoicingCurrency, PAYMENT_EPSILON } from './billing-states';

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export interface ForecastCurrencyAmount {
	currency: string;
	amount: number;
	invoices: number;
}

export interface ForecastBucket {
	/** Suma en moneda de sistema (solo facturas convertidas). */
	system: number;
	by_currency: ForecastCurrencyAmount[];
	invoices: number;
	/** Facturas sin conversión a sistema (suman en su moneda, no en `system`). */
	unconverted: number;
}

export interface PaymentBehaviour {
	client_id: string | null;
	/** Días promedio entre emisión y el último pago de sus facturas pagadas (12 meses). */
	avg_days_to_pay: number | null;
	/** Días promedio entre vencimiento y el último pago (negativo = paga antes). */
	avg_days_late: number | null;
	paid_invoices: number;
}

export interface ForecastClient {
	client_id: string | null;
	name: string;
	overdue: number;
	no_due_date: number;
	later: number;
	/** Monto en sistema por columna (`key` del período). */
	cells: Record<string, number>;
	total: number;
	unconverted: number;
	avg_days_to_pay: number | null;
	avg_days_late: number | null;
	paid_invoices: number;
}

/** Proyección de una compañía emisora (moneda de sistema), para el Excel y la tabla por compañía. */
export interface ForecastCompany {
	company_id: string | null;
	name: string;
	country: string | null;
	overdue: number;
	no_due_date: number;
	later: number;
	cells: Record<string, number>;
	total: number;
	unconverted: number;
}

export interface ForecastResult {
	periods: CalendarPeriod[];
	columns: Record<string, ForecastBucket>;
	overdue: ForecastBucket;
	no_due_date: ForecastBucket;
	later: ForecastBucket;
	total: ForecastBucket;
	clients: ForecastClient[];
	/** Misma proyección por compañía emisora (mayor saldo primero). */
	companies: ForecastCompany[];
	/** Facturas CLF/UF con saldo (fuera de la proyección). */
	review_invoices: number;
}

const emptyBucket = (): ForecastBucket => ({ system: 0, by_currency: [], invoices: 0, unconverted: 0 });

function addTo(bucket: ForecastBucket, currency: string, balance: number, system: number | null) {
	const entry = bucket.by_currency.find((item) => item.currency === currency);

	if (entry) {
		entry.amount = round2(entry.amount + balance);
		entry.invoices += 1;
	} else bucket.by_currency.push({ currency, amount: round2(balance), invoices: 1 });
	bucket.invoices += 1;
	if (system === null) bucket.unconverted += 1;
	else bucket.system = round2(bucket.system + system);
}

const sortCurrencies = (bucket: ForecastBucket): ForecastBucket => ({
	...bucket,
	by_currency: [...bucket.by_currency].sort((a, b) => a.currency.localeCompare(b.currency)),
});

/** Proyección de cobros por vencimiento (ver encabezado). `behaviour` = comportamiento de pago por cliente (opcional). */
export function buildForecast(
	rows: AgingRow[],
	{
		asOf,
		periods,
		granularity,
		behaviour = [],
	}: { asOf: string; periods: CalendarPeriod[]; granularity: CalendarGranularity; behaviour?: PaymentBehaviour[] }
): ForecastResult {
	const keys = new Set(periods.map((period) => period.key));
	const lastEnd = periods[periods.length - 1]?.end ?? asOf;
	const columns: Record<string, ForecastBucket> = Object.fromEntries(periods.map((period) => [period.key, emptyBucket()]));
	const overdue = emptyBucket();
	const noDueDate = emptyBucket();
	const later = emptyBucket();
	const total = emptyBucket();
	const clients = new Map<string, ForecastClient>();
	const companies = new Map<string, ForecastCompany>();
	const behaviourBy = new Map(behaviour.map((entry) => [entry.client_id ?? 'none', entry]));
	let review = 0;

	for (const row of rows) {
		if (!(row.balance > PAYMENT_EPSILON)) continue;
		const currency = (row.currency ?? '—').toUpperCase();

		if (isNonInvoicingCurrency(currency)) {
			review += 1;
			continue;
		}
		const system = row.balance_system === undefined || row.balance_system === null ? null : round2(row.balance_system);
		const key = row.client_id ?? 'none';
		const known = behaviourBy.get(key);
		const client = clients.get(key) ?? {
			client_id: row.client_id,
			name: row.client_name ?? 'Sin cliente',
			overdue: 0,
			no_due_date: 0,
			later: 0,
			cells: {},
			total: 0,
			unconverted: 0,
			avg_days_to_pay: known?.avg_days_to_pay ?? null,
			avg_days_late: known?.avg_days_late ?? null,
			paid_invoices: known?.paid_invoices ?? 0,
		};
		const companyKey = row.company_id ?? 'none';
		const company = companies.get(companyKey) ?? {
			company_id: row.company_id ?? null,
			name: row.company_name ?? 'Sin compañía',
			country: row.company_country ?? null,
			overdue: 0,
			no_due_date: 0,
			later: 0,
			cells: {},
			total: 0,
			unconverted: 0,
		};
		const amount = system ?? 0;
		let target: ForecastBucket;
		let slot: 'overdue' | 'no_due_date' | 'later' | string;

		if (!row.due_date) {
			target = noDueDate;
			slot = 'no_due_date';
		} else if (row.due_date < asOf) {
			target = overdue;
			slot = 'overdue';
		} else if (row.due_date > lastEnd) {
			target = later;
			slot = 'later';
		} else {
			const column = periodKeyOf(row.due_date, granularity);

			target = keys.has(column) ? columns[column] : later;
			slot = keys.has(column) ? column : 'later';
		}
		for (const entry of [client, company]) {
			if (slot === 'overdue' || slot === 'no_due_date' || slot === 'later') entry[slot] = round2(entry[slot] + amount);
			else entry.cells[slot] = round2((entry.cells[slot] ?? 0) + amount);
			entry.total = round2(entry.total + amount);
			if (system === null) entry.unconverted += 1;
		}
		addTo(target, currency, row.balance, system);
		addTo(total, currency, row.balance, system);
		clients.set(key, client);
		companies.set(companyKey, company);
	}

	return {
		periods,
		columns: Object.fromEntries(Object.entries(columns).map(([key, bucket]) => [key, sortCurrencies(bucket)])),
		overdue: sortCurrencies(overdue),
		no_due_date: sortCurrencies(noDueDate),
		later: sortCurrencies(later),
		total: sortCurrencies(total),
		clients: [...clients.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'es')),
		companies: [...companies.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'es')),
		review_invoices: review,
	};
}

export interface GoalMonth {
	month: string;
	/** Cobrado en el mes (pagos monetarios, moneda de sistema; sin ajustes no monetarios). */
	collected: number;
	/** Saldo abierto que se espera cobrar en el mes: vencimiento en el mes; lo vencido al corte cae en el mes del corte. */
	expected: number;
	/** Presupuesto de ingresos a caja del mes (`null` = sin presupuesto). */
	budget: number | null;
	/** (Cobrado + esperado) ÷ presupuesto del mes, en % (`null` sin presupuesto o presupuesto 0). */
	pct: number | null;
}

export interface GoalResult {
	year: number;
	currency: string;
	/** Presupuesto anual de ingresos a caja (suma de los meses; `null` = sin presupuesto). */
	goal: number | null;
	collected: number;
	/** Saldo abierto que vence dentro del año (incluye lo vencido al corte). */
	open_due: number;
	overdue: number;
	/** Saldo abierto sin vencimiento (no entra al proyectado). */
	no_due_date: number;
	projected: number;
	/** Cobrado / presupuesto (0–∞, sin tope; `null` sin presupuesto). */
	pct_collected: number | null;
	pct_projected: number | null;
	/** Presupuesto acumulado hasta el mes del corte (inclusive) y cobrado ÷ ese presupuesto: el cumplimiento a la fecha. */
	budget_ytd: number | null;
	pct_ytd: number | null;
	months: GoalMonth[];
}

const pctOf = (value: number, base: number | null | undefined) => (base && base > 0 ? Math.round((value / base) * 1000) / 10 : null);

/**
 * Presupuesto vs proyectado vs cobrado del año `year`. `budgetByMonth` = presupuesto `cash_in` por mes `YYYY-MM` (o `null` sin presupuesto);
 * `collectedByMonth` = cobrado por mes (moneda de sistema); `rows` = saldo abierto al corte `asOf`. Proyectado = cobrado + saldo que vence en
 * el año (lo vencido al corte cuenta, en el mes del corte).
 */
export function buildGoal({
	year,
	currency,
	budgetByMonth,
	asOf,
	rows,
	collectedByMonth,
}: {
	year: number;
	currency: string;
	budgetByMonth: Record<string, number> | null;
	asOf: string;
	rows: AgingRow[];
	collectedByMonth: Record<string, number>;
}): GoalResult {
	const yearEnd = `${year}-12-31`;
	const asOfMonth = asOf.slice(0, 7);
	const months: GoalMonth[] = Array.from({ length: 12 }, (_, index) => {
		const month = `${year}-${String(index + 1).padStart(2, '0')}`;

		return {
			month,
			collected: round2(collectedByMonth[month] ?? 0),
			expected: 0,
			budget: budgetByMonth ? round2(budgetByMonth[month] ?? 0) : null,
			pct: null,
		};
	});
	let overdue = 0;
	let openDue = 0;
	let noDueDate = 0;

	for (const row of rows) {
		if (
			!(row.balance > PAYMENT_EPSILON) ||
			isNonInvoicingCurrency(row.currency) ||
			row.balance_system === null ||
			row.balance_system === undefined
		)
			continue;
		const amount = row.balance_system;

		if (!row.due_date) {
			if (asOf.slice(0, 4) === String(year)) noDueDate += amount;
			continue;
		}
		const overdueRow = row.due_date < asOf;

		// Lo vencido se espera en el año del corte; lo por vencer, en el año de su vencimiento (un año pasado solo tiene cobrado).
		if (overdueRow ? asOf.slice(0, 4) !== String(year) : row.due_date.slice(0, 4) !== String(year) || row.due_date > yearEnd) continue;
		const month = overdueRow ? asOfMonth : row.due_date.slice(0, 7);

		if (overdueRow) overdue += amount;
		openDue += amount;
		const entry = months.find((item) => item.month === month);

		if (entry) entry.expected = round2(entry.expected + amount);
	}
	for (const month of months) month.pct = pctOf(month.collected + month.expected, month.budget);
	const collected = round2(months.reduce((sum, month) => sum + month.collected, 0));
	const projected = round2(collected + openDue);
	const goal = budgetByMonth ? round2(months.reduce((sum, month) => sum + (month.budget ?? 0), 0)) : null;
	const ytdMonths = months.filter((month) => month.month <= asOfMonth);
	const budgetYtd = goal === null ? null : round2(ytdMonths.reduce((sum, month) => sum + (month.budget ?? 0), 0));
	const collectedYtd = ytdMonths.reduce((sum, month) => sum + month.collected, 0);

	return {
		year,
		currency,
		goal,
		collected,
		open_due: round2(openDue),
		overdue: round2(overdue),
		no_due_date: round2(noDueDate),
		projected,
		pct_collected: pctOf(collected, goal),
		pct_projected: pctOf(projected, goal),
		budget_ytd: budgetYtd,
		pct_ytd: pctOf(collectedYtd, budgetYtd),
		months,
	};
}

export interface ForecastBudgetPeriod {
	/** Presupuesto del período (`null` = el período no tiene presupuesto). */
	budget: number | null;
	/** Cobrado en el período hasta el corte (pagos monetarios, sistema). */
	collected: number;
	/** Saldo que vence en el período (+ lo vencido al corte, en el período del corte). */
	projected: number;
	/** (Cobrado + proyectado) ÷ presupuesto, en %. */
	pct: number | null;
}

export interface ForecastBudget {
	/** `holding` = presupuesto total; `companies` = suma del reparto de las compañías filtradas; `unavailable` = el filtro no tiene presupuesto. */
	scope: 'holding' | 'companies' | 'unavailable' | 'none';
	currency: string | null;
	budget_ids: string[];
	/** Años del rango sin presupuesto activo. */
	missing_years: number[];
	periods: Record<string, ForecastBudgetPeriod>;
	total: { budget: number | null; collected: number; projected: number; pct: number | null };
	/** Presupuesto por compañía y período (solo si el presupuesto tiene reparto por compañía). */
	by_company: Array<{ company_id: string; budget: Record<string, number | null>; total: number | null }>;
	reason: string | null;
}

/**
 * Presupuesto vs cobrado vs proyectado por período de la proyección. `budgetByPeriod` = presupuesto ya alineado a los períodos (ver
 * `alignToPeriods` de budgets); `collectedByDay` = cobrado por día; el período del corte suma lo **Vencido por cobrar** a su proyectado.
 */
export function buildForecastBudget({
	forecast,
	asOf,
	budgetByPeriod,
	collectedByDay,
}: {
	forecast: Pick<ForecastResult, 'periods' | 'columns' | 'overdue'>;
	asOf: string;
	budgetByPeriod: Record<string, number | null> | null;
	collectedByDay: Record<string, number>;
}): Pick<ForecastBudget, 'periods' | 'total'> {
	const periods: Record<string, ForecastBudgetPeriod> = {};
	let budgetTotal: number | null = null;
	let collectedTotal = 0;
	let projectedTotal = 0;

	for (const period of forecast.periods) {
		const collected = round2(
			Object.entries(collectedByDay)
				.filter(([day]) => day >= period.start && day <= period.end && day <= asOf)
				.reduce((sum, [, amount]) => sum + amount, 0)
		);
		const containsCut = period.start <= asOf && asOf <= period.end;
		const projected = round2((forecast.columns[period.key]?.system ?? 0) + (containsCut ? forecast.overdue.system : 0));
		const budget = budgetByPeriod ? (budgetByPeriod[period.key] ?? null) : null;

		periods[period.key] = { budget, collected, projected, pct: pctOf(collected + projected, budget) };
		if (budget !== null) budgetTotal = round2((budgetTotal ?? 0) + budget);
		collectedTotal = round2(collectedTotal + collected);
		projectedTotal = round2(projectedTotal + projected);
	}

	return {
		periods,
		total: {
			budget: budgetTotal,
			collected: collectedTotal,
			projected: projectedTotal,
			pct: pctOf(collectedTotal + projectedTotal, budgetTotal),
		},
	};
}

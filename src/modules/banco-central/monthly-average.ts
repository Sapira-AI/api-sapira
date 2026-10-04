/**
 * Regla del promedio mensual de tipos de cambio (`exchange_rates_monthly_avg`), corregida el 04-10 (decisión de Domi). Una sola
 * definición de "tasa diaria que entra al promedio" para `ExchangeRatesService.calculateMonthlyAverages`, la cobertura del cierre
 * (`FxMonthCloseService.coverage`) y la migración `1791500000000-LimpiaPromediosMensualesManuales`.
 *
 * 1. **Todas las fuentes diarias**: Banco Central de Chile (`BANCOCENTRAL`, y `BANCOCENTRALCHILE`, el nombre del sistema anterior hasta el
 *    10-10-2025) y Perú API (`PERU_API`, USD/PEN desde el 17-07-2026). Antes se filtraba una sola fuente por par, y los meses en que la
 *    fuente cambió quedaban con menos días (oct-2025: 14 de 23; jul-2026 USD/PEN: 15 de 23). Las cargas manuales (`system`, una sola
 *    carga de `exchangerate-api` el 02-01-2026) **no** son una fuente diaria y no entran: varias están invertidas (ARS/USD = 1.452,25,
 *    BRL/USD = 5,48).
 * 2. **Una sola tasa por par y día**. La PK de `exchange_rates` (`rate_date, from_currency, to_currency`) ya lo garantiza; si alguna vez
 *    hubiera más de una, gana la fuente de mayor prioridad (`MONTHLY_AVG_SOURCE_PRIORITY`: Perú API para USD/PEN, después Banco Central,
 *    después Banco Central del sistema anterior) y, a igual fuente, la más reciente (`created_at`). Nunca se promedian duplicados.
 * 3. **Solo días hábiles (lunes a viernes) para todas las monedas**, UF y USD/PEN incluidas: los fines de semana que algunas fuentes
 *    publican o rellenan (repiten el viernes) no entran.
 * 4. **Cerrado** = calculado después de terminado el mes (`calculated_at` ≥ primer instante del mes siguiente en America/Santiago) y con
 *    más de una tasa diaria (`data_points > 1`). Un cálculo del mes en curso (la sincronización diaria) queda abierto por construcción.
 *    Es la condición que leen `revenue_schedule_apply_fx_for_contract` (moneda de compañía) y `FxMonthCloseService`.
 */

/** Zona con la que se decide que un mes terminó (las tasas son globales): la de negocio, igual que el scheduler y el cierre. */
export const MONTHLY_AVG_TIMEZONE = 'America/Santiago';

/** Fuentes diarias que entran al promedio, en orden de prioridad (la primera gana si hay dos tasas del mismo día). */
export const MONTHLY_AVG_DAILY_SOURCES = ['PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE'] as const;

/** Prioridad de una fuente para un par (menor = gana). Perú API solo es la primera para USD/PEN. */
export function monthlyAvgSourcePriority(source: string, from: string, to: string): number {
	if (source === 'PERU_API') return from === 'USD' && to === 'PEN' ? 0 : 3;
	if (source === 'BANCOCENTRAL') return 1;
	if (source === 'BANCOCENTRALCHILE') return 2;

	return 9;
}

/** Misma prioridad en SQL (alias `er` = `exchange_rates`). */
export const MONTHLY_AVG_SOURCE_PRIORITY_SQL = `(CASE
	WHEN er.source_type = 'PERU_API' THEN CASE WHEN er.from_currency = 'USD' AND er.to_currency = 'PEN' THEN 0 ELSE 3 END
	WHEN er.source_type = 'BANCOCENTRAL' THEN 1
	WHEN er.source_type = 'BANCOCENTRALCHILE' THEN 2
	ELSE 9 END)`;

/**
 * Tasas diarias que entran al promedio de los meses `[$1, $2)` (fechas `YYYY-MM-01`): una por par y día hábil, de una fuente diaria, > 0.
 * Columnas: `from_currency`, `to_currency`, `rate_date`, `rate`, `source_type`.
 */
export const MONTHLY_AVG_DAILY_RATES_SQL = `
	SELECT DISTINCT ON (er.from_currency, er.to_currency, er.rate_date)
		er.from_currency, er.to_currency, er.rate_date, er.rate, er.source_type
	FROM exchange_rates er
	WHERE er.rate_date >= $1::date AND er.rate_date < $2::date
		AND er.rate > 0
		AND er.source_type IN (${MONTHLY_AVG_DAILY_SOURCES.map((source) => `'${source}'`).join(', ')})
		AND EXTRACT(ISODOW FROM er.rate_date) < 6
	ORDER BY er.from_currency, er.to_currency, er.rate_date, ${MONTHLY_AVG_SOURCE_PRIORITY_SQL}, er.created_at DESC`;

/** Promedio, mínimo, máximo y días por par y mes de `[$1, $2)` (mismas tasas que `MONTHLY_AVG_DAILY_RATES_SQL`). */
export const MONTHLY_AVG_BY_PAIR_SQL = `
	WITH daily AS (${MONTHLY_AVG_DAILY_RATES_SQL})
	SELECT from_currency, to_currency, EXTRACT(YEAR FROM rate_date)::int AS year, EXTRACT(MONTH FROM rate_date)::int AS month,
		AVG(rate) AS avg_rate, MIN(rate) AS min_rate, MAX(rate) AS max_rate, COUNT(*)::int AS data_points, MAX(rate_date)::text AS last_date
	FROM daily
	GROUP BY 1, 2, 3, 4
	ORDER BY 1, 2, 3, 4`;

/**
 * Rango de meses `[desde, hasta)` (`YYYY-MM-01`) de un cálculo: año y mes → ese mes; solo año → ese año; sin año → todo (un mes sin año
 * se filtra después, en todos los años).
 */
export function monthlyAverageRange(dto: { year?: number; month?: number }): [string, string] {
	if (dto.year && dto.month) {
		const next = dto.month === 12 ? [dto.year + 1, 1] : [dto.year, dto.month + 1];

		return [`${dto.year}-${String(dto.month).padStart(2, '0')}-01`, `${next[0]}-${String(next[1]).padStart(2, '0')}-01`];
	}
	if (dto.year) return [`${dto.year}-01-01`, `${dto.year + 1}-01-01`];

	return ['1900-01-01', '2200-01-01'];
}

/** Fecha `YYYY-MM-DD` es día hábil (lunes a viernes). */
export const isWeekday = (date: string) => {
	const dow = new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay();

	return dow !== 0 && dow !== 6;
};

export interface DailyRate {
	rate_date: string;
	rate: number;
	source_type: string;
	created_at?: string | Date | null;
}

/**
 * Referencia en TS de la regla (la que corre es el SQL): una tasa por día hábil de una fuente diaria, la de mayor prioridad y, a igual
 * fuente, la más reciente; promedio simple de esas tasas. `null` si no queda ninguna.
 */
export function monthlyAverage(
	from: string,
	to: string,
	rates: DailyRate[]
): { avg_rate: number; min_rate: number; max_rate: number; data_points: number } | null {
	const byDay = new Map<string, DailyRate>();
	const sources = new Set<string>(MONTHLY_AVG_DAILY_SOURCES);
	const time = (rate: DailyRate) => (rate.created_at ? new Date(rate.created_at).getTime() : 0);

	for (const rate of rates) {
		const day = String(rate.rate_date).slice(0, 10);

		if (!(rate.rate > 0) || !sources.has(rate.source_type) || !isWeekday(day)) continue;
		const current = byDay.get(day);
		const better =
			!current ||
			monthlyAvgSourcePriority(rate.source_type, from, to) < monthlyAvgSourcePriority(current.source_type, from, to) ||
			(monthlyAvgSourcePriority(rate.source_type, from, to) === monthlyAvgSourcePriority(current.source_type, from, to) &&
				time(rate) > time(current));

		if (better) byDay.set(day, rate);
	}
	const values = [...byDay.values()].map((rate) => Number(rate.rate));

	if (!values.length) return null;

	return {
		avg_rate: values.reduce((sum, value) => sum + value, 0) / values.length,
		min_rate: Math.min(...values),
		max_rate: Math.max(...values),
		data_points: values.length,
	};
}

/** Primer instante del mes siguiente a `year`/`month` en `timeZone` (desde ahí, un promedio recalculado queda cerrado). */
export function monthEndInstant(year: number, month: number, timeZone = MONTHLY_AVG_TIMEZONE): Date {
	const nextYear = month === 12 ? year + 1 : year;
	const nextMonth = month === 12 ? 1 : month + 1;
	const utcGuess = Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0);
	// Desfase de la zona en ese instante: la hora local que muestra la zona para el instante UTC adivinado.
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(utcGuess));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));

	return new Date(utcGuess - (shownAsUtc - utcGuess));
}

/** ¿El promedio de `year`/`month` calculado en `calculatedAt` con `dataPoints` tasas está cerrado? (punto 4 de la regla). */
export function isMonthlyAverageClosed(year: number, month: number, calculatedAt: Date | string | null, dataPoints: number | null): boolean {
	if (!calculatedAt || !dataPoints || dataPoints <= 1) return false;

	return new Date(calculatedAt).getTime() >= monthEndInstant(year, month).getTime();
}

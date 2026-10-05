/**
 * Cierre mensual de la moneda de compañía (decisión de Domi 04-10). Reglas puras del proceso del día 1 (`FxMonthCloseService`), sin
 * base de datos, para poder probarlas solas.
 *
 * Regla del devengo (`revenue_schedule_apply_fx_for_contract`): con política de promedio mensual, la moneda de compañía solo se llena en
 * meses ya terminados cuyo promedio (`exchange_rates_monthly_avg`) está CERRADO: recalculado después de terminar el mes y armado con
 * tasas diarias. El mes en curso y los futuros quedan sin convertir (`fx_to_company_source = 'pending_month_close'`).
 *
 * El proceso cierra el promedio de un mes solo si el par tiene sus tasas diarias completas (`isMonthComplete`).
 */

export const FX_MONTH_CLOSE_JOB = 'fx-month-close';
/** Zona con la que se decide qué mes terminó para las tasas (globales): la de negocio, igual que `ExchangeRatesScheduler`. */
export const FX_MONTH_CLOSE_TIMEZONE = 'America/Santiago';
/** Meses hacia atrás que el proceso revisa en busca de promedios terminados sin cerrar (backlog). */
export const FX_MONTH_CLOSE_LOOKBACK_MONTHS = 12;
/**
 * Holgura de días hábiles (lunes a viernes) por feriados: un par está completo si tiene al menos `días hábiles − 3` tasas y la última
 * cae a lo más 3 días antes del último día hábil del mes (p. ej. 31-12 es feriado bancario en Chile; septiembre tiene 18 y 19).
 */
export const FX_MONTH_CLOSE_TOLERANCE_DAYS = 3;
/** Clave de la alerta del mes: una abierta por holding y mes. */
export const fxMonthCloseKey = (month: string) => `fx-month-close:${month.slice(0, 7)}`;

/** `YYYY-MM-01` del mes de una fecha en una zona IANA. */
export function monthStartIn(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
	const year = parts.find((part) => part.type === 'year')?.value;
	const month = parts.find((part) => part.type === 'month')?.value;

	return `${year}-${month}-01`;
}

/** Suma meses a un `YYYY-MM-01`. */
export function addMonths(month: string, delta: number): string {
	const [year, mon] = month.split('-').map(Number);
	const index = year * 12 + (mon - 1) + delta;

	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

/** Día hábil (lunes a viernes) y último día hábil de un mes `YYYY-MM-01`. */
export function weekdaysOf(month: string): { weekdays: number; lastWeekday: string } {
	const [year, mon] = month.split('-').map(Number);
	const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
	let weekdays = 0;
	let lastWeekday = month;

	for (let day = 1; day <= days; day++) {
		const date = new Date(Date.UTC(year, mon - 1, day));
		const dow = date.getUTCDay();

		if (dow !== 0 && dow !== 6) {
			weekdays++;
			lastWeekday = date.toISOString().slice(0, 10);
		}
	}

	return { weekdays, lastWeekday };
}

/** Tasas diarias de un par en un mes (las que entran al promedio). */
export interface PairDailyCoverage {
	from_currency: string;
	to_currency: string;
	days: number;
	last_date: string | null;
}

export interface PairCompleteness extends PairDailyCoverage {
	complete: boolean;
	/** Motivo legible cuando no está completo. */
	reason: string | null;
}

/** ¿El par tiene sus tasas diarias completas en el mes? (días hábiles − holgura y última tasa cerca del último día hábil). */
export function isMonthComplete(month: string, coverage: PairDailyCoverage, tolerance = FX_MONTH_CLOSE_TOLERANCE_DAYS): PairCompleteness {
	const { weekdays, lastWeekday } = weekdaysOf(month);
	const minDays = Math.max(1, weekdays - tolerance);
	const lastAllowed = new Date(`${lastWeekday}T00:00:00Z`);

	lastAllowed.setUTCDate(lastAllowed.getUTCDate() - tolerance);
	const lastLimit = lastAllowed.toISOString().slice(0, 10);

	if (!coverage.days || !coverage.last_date) return { ...coverage, complete: false, reason: 'sin tasas diarias' };
	if (coverage.days < minDays) return { ...coverage, complete: false, reason: `${coverage.days} de ${weekdays} días hábiles` };
	if (coverage.last_date < lastLimit) return { ...coverage, complete: false, reason: `la última tasa es del ${coverage.last_date}` };

	return { ...coverage, complete: true, reason: null };
}

/** Resultado del proceso por holding. */
export interface FxMonthCloseHoldingResult {
	holding_id: string;
	success: boolean;
	/** Contratos recalculados (`revenue_schedule_apply_fx_for_contract`). */
	contracts: number;
	/** Contratos que fallaron (se informan; el resto sigue). */
	failed_contracts: number;
	/** Filas del mes terminado que siguen sin moneda de compañía después de la corrida (por par sin promedio cerrado). */
	pending_rows: number;
	/** Pares contrato → compañía del mes terminado que quedaron sin convertir. */
	pending_pairs: string[];
	error?: string;
}

/** Resultado de una corrida. */
export interface FxMonthCloseResult {
	/** Mes terminado que se cierra (`YYYY-MM-01`). */
	month: string;
	/** Promedios cerrados en esta corrida (`YYYY-MM PAR`). */
	closed_averages: string[];
	/** Pares con tasas diarias incompletas (`YYYY-MM PAR: motivo`): no se cierran. */
	incomplete_averages: string[];
	holdings: FxMonthCloseHoldingResult[];
}

/**
 * "Hoy" del negocio para Contratos v2 (cobertura D16 / Huecos #10): una sola regla para cambios, consumo, alta, activación, 360 y jobs.
 * La fecha es la del calendario del holding, no la UTC del servidor (después de ~21:00 en Chile la fecha UTC ya es mañana) ni la local
 * del proceso. Los holdings no guardan zona horaria (`company_holdings` / `holding_settings` no tienen columna): todos usan
 * `America/Santiago`, la misma zona del scheduler de facturas y de los crons de contratos. Si algún día se agrega la columna, basta con
 * pasarla como `holdingTimezone`.
 */
export const DEFAULT_HOLDING_TIMEZONE = 'America/Santiago';

const validTimezone = (timezone: string | null | undefined): string => {
	if (!timezone) return DEFAULT_HOLDING_TIMEZONE;
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

		return timezone;
	} catch {
		return DEFAULT_HOLDING_TIMEZONE;
	}
};

/** Fecha `YYYY-MM-DD` de `now` en la zona del holding (default `America/Santiago`; una zona inválida cae al default). */
export function todayFor(holdingTimezone?: string | null, now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: validTimezone(holdingTimezone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';

	return `${part('year')}-${part('month')}-${part('day')}`;
}

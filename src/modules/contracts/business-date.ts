/**
 * "Hoy" del negocio para Contratos v2 (cobertura D16 / Huecos #10): una sola regla para cambios, consumo, alta, activación, 360 y jobs.
 * La fecha es la del calendario del holding, no la UTC del servidor (después de ~21:00 en Chile la fecha UTC ya es mañana) ni la local
 * del proceso. Desde la ronda 4 de Configuración cada holding tiene su zona (`holding_settings.timezone`, migración M14, default
 * `America/Santiago`): los módulos la leen con `holdingTimezone(db, holdingId)` (`src/core/utils/holding-preferences.ts`) y la pasan aquí
 * como `holdingTimezone`. Sin zona (o inválida) rige `America/Santiago`.
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

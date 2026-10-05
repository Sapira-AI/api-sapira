/**
 * Hora local de un holding (`holding_settings.timezone`) para los jobs de Notificaciones (resumen semanal de los lunes 08:00 y aviso de
 * cierre de mes a las 07:00). Puro: sin Nest ni base.
 */
export interface LocalParts {
	/** `YYYY-MM-DD` en la zona. */
	date: string;
	/** 1 = lunes … 7 = domingo. */
	weekday: number;
	hour: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(now: Date, timezone: string): LocalParts {
	let parts: Intl.DateTimeFormatPart[];

	try {
		parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			weekday: 'short',
			hour: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(now);
	} catch {
		return localParts(now, 'America/Santiago');
	}
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

	return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: WEEKDAYS[get('weekday')] ?? 0, hour: Number(get('hour')) % 24 };
}

/** Lunes (`YYYY-MM-DD`) de la semana de `date`. */
export function mondayOf(date: string): string {
	const [year, month, day] = date.split('-').map(Number);
	const value = new Date(Date.UTC(year, month - 1, day));
	const offset = (value.getUTCDay() + 6) % 7;

	value.setUTCDate(value.getUTCDate() - offset);

	return value.toISOString().slice(0, 10);
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "Semana del 5 de octubre de 2026". */
export function weekLabel(monday: string): string {
	const [year, month, day] = monday.split('-').map(Number);

	return `Semana del ${day} de ${MONTHS[month - 1]} de ${year}`;
}

/** "octubre de 2026" desde `YYYY-MM`. */
export function monthName(month: string): string {
	const [year, value] = month.split('-').map(Number);

	return `${MONTHS[value - 1] ?? month} de ${year}`;
}

/** `USD 12.345` (sin decimales; montos de resumen). */
export function money(amount: number | null | undefined, currency: string): string {
	const value = Math.round(Number(amount ?? 0));

	return `${currency} ${value.toLocaleString('es-CL')}`;
}

/** `+USD 1.200` / `−USD 300`. */
export function signedMoney(amount: number, currency: string): string {
	return `${amount >= 0 ? '+' : '−'}${money(Math.abs(amount), currency)}`;
}

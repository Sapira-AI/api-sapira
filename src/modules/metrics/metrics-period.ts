import { BadRequestException } from '@nestjs/common';

/** Mes como `YYYY-MM`. Todo el módulo trabaja con meses de texto: nada de `Date` ni `toISOString()` (el viejo corría un mes en Chile). */
export type Month = string;

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Máximo de meses de una serie (como el roll-forward de NetSuite): acota matrices y consultas. */
export const MAX_RANGE_MONTHS = 36;

const toIndex = (month: Month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const fromIndex = (index: number): Month => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

export const addMonths = (month: Month, delta: number): Month => fromIndex(toIndex(month) + delta);
export const monthsBetween = (from: Month, to: Month) => toIndex(to) - toIndex(from);
/** Primer día del mes para SQL (`period_month` es siempre el día 1). */
export const monthStart = (month: Month) => `${month}-01`;

/** Meses de `from` a `to`, ambos incluidos. */
export function monthRange(from: Month, to: Month): Month[] {
	const out: Month[] = [];

	for (let index = toIndex(from); index <= toIndex(to); index++) out.push(fromIndex(index));

	return out;
}

/** Mes calendario de una fecha en la zona del negocio (America/Santiago), sin pasar por UTC. */
export function currentMonth(now = new Date(), timeZone = 'America/Santiago'): Month {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
	const year = parts.find((part) => part.type === 'year')?.value;
	const month = parts.find((part) => part.type === 'month')?.value;

	return `${year}-${month}`;
}

/**
 * Rango pedido: default los 12 meses que terminan en el mes actual; valida orden y tamaño.
 * 400 con `errors[{ field, message }]` (contrato de la casa).
 */
export function resolveRange(from?: string, to?: string, now = new Date()): { from: Month; to: Month; months: Month[] } {
	const end = to ?? (from ? addMonths(from, 11) : currentMonth(now));
	const start = from ?? addMonths(end, -11);

	if (!MONTH_RE.test(start) || !MONTH_RE.test(end)) {
		throw new BadRequestException({ message: 'Rango inválido', errors: [{ field: 'from', message: 'Usa meses YYYY-MM' }] });
	}
	if (monthsBetween(start, end) < 0) {
		throw new BadRequestException({
			message: 'Rango inválido',
			errors: [{ field: 'to', message: 'El mes final debe ser igual o posterior al inicial' }],
		});
	}
	if (monthsBetween(start, end) + 1 > MAX_RANGE_MONTHS) {
		throw new BadRequestException({
			message: 'Rango inválido',
			errors: [{ field: 'from', message: `El rango admite hasta ${MAX_RANGE_MONTHS} meses` }],
		});
	}

	return { from: start, to: end, months: monthRange(start, end) };
}

/**
 * Conciliación bancaria v2 · normalización de cartolas (`docs/v2-rediseno/spec-conciliacion-v2.md` §3.1, §6.5): puro, sin base.
 *
 * El navegador lee el archivo (CSV/XLSX) y manda encabezados + filas crudas + mapeo; aquí se decide todo: fecha (formatos, seriales de
 * Excel, años de 2 dígitos, detección automática), monto con signo (abono > 0, cargo < 0; columnas de cargo/abono, convención de signo,
 * paréntesis, símbolos de moneda), moneda (columna, por defecto o de la cuenta), referencia, RUT del pagador (columna o glosa con DV
 * módulo 11), nombre del pagador y saldo. La huella por línea (`fingerprintOf`) hace idempotente la importación.
 */
import { createHash } from 'crypto';

import { counterpartyNameOf, extractRut, normalizeTaxId, normalizeText, round2 } from './billing-reconciliation-match';

import type { BillingBlocker } from './billing-states';

export const DATE_FORMATS = ['auto', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY'] as const;
export const DECIMAL_SEPARATORS = [',', '.'] as const;
export const THOUSANDS_SEPARATORS = ['.', ',', ' ', 'none'] as const;
export const SIGN_CONVENTIONS = ['credit_positive', 'credit_negative'] as const;
export const STATEMENT_FORMATS = ['csv', 'xlsx'] as const;
export const STATEMENT_MAX_ROWS = 5000;

export type DateFormat = (typeof DATE_FORMATS)[number];

/** Mapeo de columnas (por nombre de encabezado). `amount_column` o bien `debit_column`/`credit_column`. */
export interface StatementMapping {
	date_column: string;
	description_column: string;
	amount_column?: string | null;
	debit_column?: string | null;
	credit_column?: string | null;
	currency_column?: string | null;
	reference_column?: string | null;
	tax_id_column?: string | null;
	balance_column?: string | null;
	default_currency?: string | null;
	date_format: DateFormat;
	decimal_separator: (typeof DECIMAL_SEPARATORS)[number];
	thousands_separator: (typeof THOUSANDS_SEPARATORS)[number];
	amount_sign_convention: (typeof SIGN_CONVENTIONS)[number];
	/** Filas de datos a saltar al inicio (totales o leyendas del banco bajo el encabezado). */
	skip_rows?: number | null;
	bank_name?: string | null;
}

export interface StatementAccount {
	id: string;
	currency: string | null;
}

export interface StatementLineError {
	code: string;
	message: string;
}

export interface StatementLine {
	/** N.º de fila de datos en el archivo (1 = primera fila bajo el encabezado). */
	row: number;
	date: string | null;
	description: string;
	amount: number | null;
	currency: string | null;
	reference: string | null;
	counterparty_tax_id: string | null;
	counterparty_name: string | null;
	balance: number | null;
	raw: Record<string, string>;
	fingerprint: string | null;
	errors: StatementLineError[];
}

// ---------------------------------------------------------------- celdas

export const cellText = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

const pad = (value: number) => String(value).padStart(2, '0');

const validDate = (year: number, month: number, day: number): string | null => {
	if (!(year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
	const time = Date.UTC(year, month - 1, day);
	const date = new Date(time);

	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
};

/** Serial de Excel (días desde 1899-12-30) → `YYYY-MM-DD`; solo rangos plausibles (1954–2119). */
export function excelSerialToDate(serial: number): string | null {
	if (!(serial >= 20000 && serial < 80000)) return null;
	const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);

	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const fullYear = (value: string) => {
	const year = Number(value);

	return value.length <= 2 ? (year < 70 ? 2000 + year : 1900 + year) : year;
};

/**
 * Fecha → `YYYY-MM-DD` o null. Acepta seriales de Excel (número o texto de 5 dígitos), hora al final (se ignora), separadores `/`, `-`,
 * `.`; `auto`: año primero si tiene 4 dígitos, si no día primero salvo que el segundo número no pueda ser mes (convención chilena).
 */
export function parseDate(value: unknown, format: DateFormat = 'auto'): string | null {
	if (typeof value === 'number') return excelSerialToDate(value);
	const text = cellText(value);

	if (!text) return null;
	if (/^\d{5}(\.\d+)?$/.test(text)) return excelSerialToDate(Number(text));
	const head = text.split(/[ T]/)[0];
	const parts = head.split(/[/.-]/);

	if (parts.length !== 3 || !parts.every((part) => /^\d{1,4}$/.test(part))) return null;
	const [a, b, c] = parts;
	const yearFirst = a.length === 4;

	if (format === 'YYYY-MM-DD' || (format === 'auto' && yearFirst)) return yearFirst ? validDate(Number(a), Number(b), Number(c)) : null;
	if (yearFirst || c.length === 3) return null;
	if (format === 'MM/DD/YYYY') return validDate(fullYear(c), Number(a), Number(b));
	if (format === 'DD/MM/YYYY' || format === 'DD-MM-YYYY') return validDate(fullYear(c), Number(b), Number(a));
	// auto, día primero salvo que el segundo no pueda ser mes.
	if (Number(b) > 12 && Number(a) <= 12) return validDate(fullYear(c), Number(a), Number(b));

	return validDate(fullYear(c), Number(b), Number(a));
}

/**
 * Monto → número con signo o null (vacío o ilegible). Quita símbolos y letras de moneda; negativos con `-` adelante o atrás o entre
 * paréntesis; separadores según el mapeo (`none` = sin miles).
 */
export function parseAmount(
	value: unknown,
	decimal: StatementMapping['decimal_separator'] = ',',
	thousands: StatementMapping['thousands_separator'] = '.'
): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	let text = cellText(value).replace(/ /g, ' ');

	if (!text) return null;
	let negative = false;

	text = text.replace(/[^\d.,\s()-]/g, '').trim();
	if (/^\(.*\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1).trim();
	}
	if (text.startsWith('-')) {
		negative = !negative;
		text = text.slice(1);
	} else if (text.endsWith('-')) {
		negative = !negative;
		text = text.slice(0, -1);
	}
	if (thousands === ' ') text = text.replace(/\s+/g, '');
	else {
		text = text.replace(/\s+/g, '');
		if (thousands !== 'none') text = text.split(thousands).join('');
	}
	if (decimal === ',') text = text.replace(',', '.');
	if (!/^\d+(\.\d+)?$/.test(text) && !/^\.\d+$/.test(text)) return null;
	const amount = Number(text);

	return Number.isFinite(amount) ? (negative ? -amount : amount) : null;
}

/** Moneda ISO en mayúsculas (`US$` → USD, `$` sin más → null); null si no se puede leer. */
export function parseCurrency(value: unknown): string | null {
	const text = cellText(value).toUpperCase();

	if (!text) return null;
	if (/^US\$?$|^U\$S$/.test(text)) return 'USD';
	const letters = text.replace(/[^A-Z]/g, '');

	return /^[A-Z]{3}$/.test(letters) ? letters : null;
}

// ---------------------------------------------------------------- mapeo

const MAPPING_COLUMNS = [
	'date_column',
	'description_column',
	'amount_column',
	'debit_column',
	'credit_column',
	'currency_column',
	'reference_column',
	'tax_id_column',
	'balance_column',
] as const;

/** Bloqueos del mapeo frente a los encabezados: columnas inexistentes y monto sin columna (ni cargo/abono). */
export function validateMapping(headers: string[], mapping: StatementMapping): BillingBlocker[] {
	const blockers: BillingBlocker[] = [];
	const names = new Set(headers.map((header) => cellText(header)));

	for (const key of MAPPING_COLUMNS) {
		const column = mapping[key];

		if (column && !names.has(cellText(column))) {
			blockers.push({
				code: 'mapping_column_missing',
				message: `La columna "${column}" (${key}) no está en el archivo`,
				next_step: 'Revisa el mapeo',
			});
		}
	}
	if (!mapping.amount_column && !mapping.debit_column && !mapping.credit_column) {
		blockers.push({
			code: 'mapping_amount_missing',
			message: 'Indica la columna de monto o las de cargo y abono',
			next_step: 'Completa el mapeo',
		});
	}

	return blockers;
}

// ---------------------------------------------------------------- líneas

/** Monto con signo desde el mapeo: abono > 0, cargo < 0; null si no hay monto legible. */
function amountOf(cells: (column?: string | null) => string, mapping: StatementMapping): number | null {
	if (mapping.amount_column) {
		const amount = parseAmount(cells(mapping.amount_column), mapping.decimal_separator, mapping.thousands_separator);

		if (amount === null) return null;

		return round2(mapping.amount_sign_convention === 'credit_negative' ? -amount : amount);
	}
	const credit = mapping.credit_column ? parseAmount(cells(mapping.credit_column), mapping.decimal_separator, mapping.thousands_separator) : null;
	const debit = mapping.debit_column ? parseAmount(cells(mapping.debit_column), mapping.decimal_separator, mapping.thousands_separator) : null;

	if (credit === null && debit === null) return null;

	return round2(Math.abs(credit ?? 0) - Math.abs(debit ?? 0));
}

/**
 * Normaliza las filas con el mapeo (encabezados por nombre). Cada línea trae sus errores (`date_unreadable`, `amount_unreadable`,
 * `currency_unreadable`, `account_currency_mismatch`) y su huella (null si tiene errores). Las filas totalmente vacías se omiten.
 */
export function parseStatement(headers: string[], rows: unknown[][], mapping: StatementMapping, account: StatementAccount): StatementLine[] {
	const index = new Map(headers.map((header, position) => [cellText(header), position]));
	const accountCurrency = account.currency ? account.currency.toUpperCase() : null;
	const skip = Math.max(0, Number(mapping.skip_rows ?? 0) || 0);
	const lines: StatementLine[] = [];

	rows.forEach((row, position) => {
		if (position < skip || !Array.isArray(row) || row.every((cell) => cellText(cell) === '')) return;
		const cells = (column?: string | null) => {
			if (!column) return '';
			const at = index.get(cellText(column));

			return at === undefined ? '' : cellText(row[at]);
		};
		const rawCell = (column?: string | null) => (column && index.has(cellText(column)) ? row[index.get(cellText(column))] : undefined);
		const raw: Record<string, string> = {};

		headers.forEach((header, at) => {
			raw[cellText(header) || `col_${at + 1}`] = cellText(row[at]);
		});
		const errors: StatementLineError[] = [];
		const date = parseDate(rawCell(mapping.date_column), mapping.date_format);
		const amount = amountOf(cells, mapping);
		const description = cells(mapping.description_column);
		const currencyCell = mapping.currency_column ? cells(mapping.currency_column) : '';
		let currency = currencyCell ? parseCurrency(currencyCell) : null;

		if (!date) errors.push({ code: 'date_unreadable', message: `Fecha ilegible: "${cellText(rawCell(mapping.date_column))}"` });
		if (amount === null) errors.push({ code: 'amount_unreadable', message: 'Monto ilegible o vacío' });
		if (currencyCell && !currency) errors.push({ code: 'currency_unreadable', message: `Moneda ilegible: "${currencyCell}"` });
		if (!currencyCell) currency = parseCurrency(mapping.default_currency) ?? accountCurrency;
		if (currency && accountCurrency && currency !== accountCurrency) {
			errors.push({
				code: 'account_currency_mismatch',
				message: `La línea es en ${currency} y la cuenta en ${accountCurrency}`,
			});
		}
		const taxCell = mapping.tax_id_column ? cells(mapping.tax_id_column) : '';
		const balance = mapping.balance_column
			? parseAmount(cells(mapping.balance_column), mapping.decimal_separator, mapping.thousands_separator)
			: null;

		lines.push({
			row: position + 1,
			date,
			description,
			amount,
			currency,
			reference: (mapping.reference_column ? cells(mapping.reference_column) : '') || null,
			counterparty_tax_id: (taxCell ? normalizeTaxId(taxCell) : null) ?? extractRut(description),
			counterparty_name: counterpartyNameOf(description),
			balance: balance === null ? null : round2(balance),
			raw,
			fingerprint: null,
			errors,
		});
	});

	return assignFingerprints(account.id, lines);
}

// ---------------------------------------------------------------- huella por línea

/** Clave de una línea: cuenta | fecha | monto (2 decimales) | glosa normalizada | referencia o, si no hay, saldo. */
export function lineKey(accountId: string, line: Pick<StatementLine, 'date' | 'amount' | 'description' | 'reference' | 'balance'>): string {
	const tail = line.reference || (line.balance === null || line.balance === undefined ? '' : round2(line.balance).toFixed(2));

	return `${accountId}|${line.date ?? ''}|${round2(line.amount ?? 0).toFixed(2)}|${normalizeText(line.description)}|${tail}`;
}

/** sha256 hex de `clave|#n` (n = ocurrencia de la misma clave dentro del archivo, desde 0). */
export function fingerprintOf(
	accountId: string,
	line: Pick<StatementLine, 'date' | 'amount' | 'description' | 'reference' | 'balance'>,
	occurrence: number
): string {
	return createHash('sha256')
		.update(`${lineKey(accountId, line)}|#${occurrence}`)
		.digest('hex');
}

/**
 * Asigna huellas en orden: dos transferencias idénticas legítimas del mismo archivo quedan distintas (#0, #1) y un archivo que se solapa
 * con otro ya importado repite las mismas huellas (se deduplica). Las líneas con errores no llevan huella.
 */
export function assignFingerprints(accountId: string, lines: StatementLine[]): StatementLine[] {
	const seen = new Map<string, number>();

	return lines.map((line) => {
		if (line.errors.length || !line.date || line.amount === null) return { ...line, fingerprint: null };
		const key = lineKey(accountId, line);
		const occurrence = seen.get(key) ?? 0;

		seen.set(key, occurrence + 1);

		return { ...line, fingerprint: fingerprintOf(accountId, line, occurrence) };
	});
}

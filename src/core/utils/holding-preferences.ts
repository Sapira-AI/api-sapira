/**
 * Preferencias operativas del holding (`holding_settings`, Configuración v2 ronda 4, migración M14): zona horaria, escalera de recordatorios de vencimiento y numeración de cotizaciones. Una sola lectura para jobs y módulos (contratos,
 * facturación, clientes, cotizaciones).
 *
 * Se lee la fila completa como JSON (`to_jsonb`): si M14 aún no está aplicada (o el holding no tiene fila) cada columna que falta cae a su
 * default, que reproduce el comportamiento anterior a la ronda 4. Nada se cae por desplegar la API antes de la migración.
 */

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export const DEFAULT_TIMEZONE = 'America/Santiago';
export const DEFAULT_RENEWAL_REMINDER_DAYS: readonly number[] = [15, 7, 0];
export const DEFAULT_RENEWAL_OVERDUE_EVERY_DAYS = 7;
export const DEFAULT_AUTO_RENEWAL_NOTICE_DAYS = 30;
export const QUOTE_NUMBERING_MODES = ['prefixed', 'sequential', 'manual'] as const;
export type QuoteNumberingMode = (typeof QUOTE_NUMBERING_MODES)[number];

export interface QuoteNumbering {
	mode: QuoteNumberingMode;
	prefix: string;
	include_year: boolean;
	width: number;
}

export const DEFAULT_QUOTE_NUMBERING: QuoteNumbering = { mode: 'prefixed', prefix: 'COT', include_year: true, width: 4 };

export interface HoldingRuntimePreferences {
	timezone: string;
	auto_renewal_notice_days: number;
	renewal_reminder_days: number[];
	renewal_overdue_every_days: number;
	quote_numbering: QuoteNumbering;
}

/** Zonas IANA aceptadas (las del runtime + `UTC`). */
export function supportedTimezones(): Set<string> {
	const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
	const zones = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];

	return new Set([...zones, 'UTC']);
}

export function isValidTimezone(value: unknown): value is string {
	if (typeof value !== 'string' || !value) return false;
	const zones = supportedTimezones();

	// Runtime sin `Intl.supportedValuesOf` (solo `UTC` en la lista): basta con que Intl la acepte.
	if (zones.size > 1) return zones.has(value);
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: value });

		return true;
	} catch {
		return false;
	}
}

const int = (value: unknown, fallback: number, min: number, max: number): number => {
	const number = Number(value);

	return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

/** Escalera guardada: enteros 0–180 sin repetidos, de mayor a menor; inválida o vacía → default. */
export function normalizeReminderDays(value: unknown): number[] {
	const raw = typeof value === 'string' ? value.replace(/[{}]/g, '').split(',').filter(Boolean) : value;

	if (!Array.isArray(raw) || !raw.length) return [...DEFAULT_RENEWAL_REMINDER_DAYS];
	const days = raw.map(Number);

	if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 180)) return [...DEFAULT_RENEWAL_REMINDER_DAYS];

	return [...new Set(days)].sort((a, b) => b - a);
}

export function preferencesFromRow(row: Record<string, unknown> | null | undefined): HoldingRuntimePreferences {
	const settings = row ?? {};
	const mode = QUOTE_NUMBERING_MODES.includes(settings.quote_numbering_mode as QuoteNumberingMode)
		? (settings.quote_numbering_mode as QuoteNumberingMode)
		: DEFAULT_QUOTE_NUMBERING.mode;
	const prefix =
		typeof settings.quote_number_prefix === 'string' && /^[A-Za-z0-9]{1,10}$/.test(settings.quote_number_prefix)
			? settings.quote_number_prefix
			: DEFAULT_QUOTE_NUMBERING.prefix;

	return {
		timezone: isValidTimezone(settings.timezone) ? settings.timezone : DEFAULT_TIMEZONE,
		auto_renewal_notice_days: int(settings.auto_renewal_notice_days, DEFAULT_AUTO_RENEWAL_NOTICE_DAYS, 1, 180),
		renewal_reminder_days: normalizeReminderDays(settings.renewal_reminder_days),
		renewal_overdue_every_days: int(settings.renewal_overdue_every_days, DEFAULT_RENEWAL_OVERDUE_EVERY_DAYS, 1, 90),
		quote_numbering: {
			mode,
			prefix,
			include_year:
				typeof settings.quote_number_include_year === 'boolean' ? settings.quote_number_include_year : DEFAULT_QUOTE_NUMBERING.include_year,
			width: int(settings.quote_number_width, DEFAULT_QUOTE_NUMBERING.width, 1, 8),
		},
	};
}

/** Preferencias del holding con defaults (tolerante a columnas que aún no existen). */
export async function loadHoldingPreferences(db: Queryable, holdingId: string): Promise<HoldingRuntimePreferences> {
	const rows = (await db.query(`SELECT to_jsonb(hs) AS settings FROM holding_settings hs WHERE hs.holding_id = $1`, [holdingId])) as Array<{
		settings?: unknown;
	}> | null;
	const raw = rows?.[0]?.settings;
	const settings = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined;

	return preferencesFromRow(settings);
}

/** Zona horaria IANA del holding (default `America/Santiago`): el "hoy" del holding es `todayFor(await holdingTimezone(...))`. */
export async function holdingTimezone(db: Queryable, holdingId: string | null | undefined): Promise<string> {
	if (!holdingId) return DEFAULT_TIMEZONE;

	return (await loadHoldingPreferences(db, holdingId)).timezone;
}

// ── Numeración de cotizaciones creadas en Sapira ───────────────────────────────────────────────────────────────────────────────

/**
 * Formato vigente del correlativo: patrón (con el grupo del número), cómo se escribe y la clave del lock. `null` en modo `manual`.
 * `prefixed` con año = `COT-2026-0001` (correlativo por año); sin año = `COT-0001`; `sequential` = `0001` (un solo correlativo).
 */
export function quoteNumberFormat(numbering: QuoteNumbering, year: number) {
	if (numbering.mode === 'manual') return null;
	const pad = (correlative: number) => String(correlative).padStart(numbering.width, '0');

	if (numbering.mode === 'sequential') return { pattern: '^(\\d{1,12})$', lockKey: 'sequential', format: pad };
	const head = numbering.include_year ? `${numbering.prefix}-${year}-` : `${numbering.prefix}-`;

	// El prefijo solo tiene letras y números (validado): no necesita escape en la expresión regular.
	// Lock `PREFIJO:AÑO` (el mismo que usaba el correlativo COT-{año} antes de la ronda 4) o `PREFIJO:sin-año`.
	return {
		pattern: `^${head}(\\d{1,12})$`,
		lockKey: `${numbering.prefix}:${numbering.include_year ? year : 'sin-año'}`,
		format: (correlative: number) => `${head}${pad(correlative)}`,
	};
}

/** Próximo número del formato = mayor de los que calzan + 1 (null en `manual`). Con `lock`, toma antes el lock del formato. */
export async function nextQuoteNumber(
	db: Queryable,
	holdingId: string,
	numbering: QuoteNumbering,
	year: number,
	lock = false
): Promise<string | null> {
	const format = quoteNumberFormat(numbering, year);

	if (!format) return null;
	if (lock) await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quotes:${holdingId}:${format.lockKey}`]);
	const rows = (await db.query(
		`SELECT COALESCE(MAX((regexp_match(quote_number, $2))[1]::bigint), 0) + 1 AS next FROM quotes WHERE holding_id = $1 AND quote_number ~ $2`,
		[holdingId, format.pattern]
	)) as Array<{ next?: unknown }> | null;

	return format.format(Number(rows?.[0]?.next ?? 1) || 1);
}

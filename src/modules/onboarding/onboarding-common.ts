import { BadRequestException, ConflictException } from '@nestjs/common';

import type { PermissionContext } from '@/guards/permissions.service';
import { addMonths, type Month, MONTH_RE } from '@/modules/metrics/metrics-period';

export type Row = Record<string, unknown>;
export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** Quién opera: `authId` (para el generador de Contratos) y `userId` (`users.id`, firma de eventos y filas). */
export interface OnboardingActor {
	authId: string;
	userId: string;
}

/** Request tras `SupabaseAuthGuard` + `HoldingScopeGuard` + `RequirePermissionGuard`. */
export interface OnboardingRequest {
	user?: { sub?: string; id?: string };
	permissionContext?: PermissionContext;
}

export const actorOf = (req: OnboardingRequest): OnboardingActor => ({
	authId: String(req.user?.sub ?? req.user?.id ?? ''),
	userId: String(req.permissionContext?.userId ?? ''),
});

export const num = (value: unknown): number => Number(value ?? 0) || 0;
export const numOrNull = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Number(value));
export const str = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
export const round2 = (value: number): number => Math.round(value * 100) / 100;
export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Fecha de Postgres (`date` llega como Date o texto) → `YYYY-MM-DD`, sin pasar por UTC. */
export function isoDate(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) {
		return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
	}

	return String(value).slice(0, 10);
}

export const monthOf = (value: unknown): Month | null => isoDate(value)?.slice(0, 7) ?? null;
export const firstDay = (month: Month): string => `${month}-01`;
/** Primer día del mes siguiente (`2026-07` → `2026-08-01`). */
export const nextMonthStart = (month: Month): string => firstDay(addMonths(month, 1));

/** Copia sin una clave (para no mandar campos propios del módulo a otros servicios ni a la respuesta). */
export function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const copy = { ...value };

	delete copy[key];

	return copy;
}

/** 409 con `{ code, message, ...extra }` (contrato de la casa). */
export const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ code, message, ...extra });

/** Paginación interna `{ data, total, currentPage, pages, limit }`. */
export function paginated<T>(data: T[], total: number, page: number, limit: number) {
	return { data, total, currentPage: page, pages: Math.max(1, Math.ceil(total / limit)), limit };
}

// ── Clave de línea de MRR histórico ─────────────────────────────────────────────────────────────────────────────────────────────

/** Grano de lectura de una línea (§3.1): cliente comercial × producto × moneda de contrato. */
export interface LineKeyParts {
	client_id: string;
	product_name: string;
	contract_currency: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clave cruda `client_id|product_name|contract_currency` (la que se guarda en `onboarding_events.line_key`). */
export const rawLineKey = (parts: LineKeyParts): string => `${parts.client_id}|${parts.product_name}|${parts.contract_currency}`;

/** Clave segura para la URL: base64url de la clave cruda (el nombre del producto puede traer `/`, `|`, espacios o tildes). */
export const encodeLineKey = (parts: LineKeyParts): string => Buffer.from(rawLineKey(parts), 'utf8').toString('base64url');

/** Clave cruda → partes. El producto puede contener `|`: el cliente es lo anterior al primero y la moneda lo posterior al último. */
export function parseRawLineKey(raw: string): LineKeyParts | null {
	const first = raw.indexOf('|');
	const last = raw.lastIndexOf('|');

	if (first < 0 || last <= first) return null;
	const parts = { client_id: raw.slice(0, first), product_name: raw.slice(first + 1, last), contract_currency: raw.slice(last + 1) };

	return UUID_RE.test(parts.client_id) && parts.contract_currency ? parts : null;
}

/** Clave de la URL → partes; 400 si no es una clave válida (nunca llega SQL con una clave rota). */
export function decodeLineKey(key: string): LineKeyParts {
	const raw = /^[A-Za-z0-9_-]+$/.test(key ?? '') ? Buffer.from(key, 'base64url').toString('utf8') : '';
	const parts = parseRawLineKey(raw);

	if (!parts)
		throw new BadRequestException({ message: 'Línea inválida', errors: [{ field: 'key', message: 'La clave de la línea no es válida' }] });

	return parts;
}

/** Categoría de los ítems de un contrato que nace del MRR histórico o del arranque rápido (Domi 14-10: viene de algo que ya existía). */
export const HISTORY_ITEM_CATEGORY = 'RENEWAL' as const;

// ── Meses ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function assertMonth(value: string, field: string): Month {
	if (!MONTH_RE.test(value ?? '')) throw new BadRequestException({ message: 'Mes inválido', errors: [{ field, message: 'Usa un mes AAAA-MM' }] });

	return value;
}

// ── Eventos ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_EVENT_TYPES = [
	'history_line_edited',
	'history_linked',
	'history_unlinked',
	'history_closed',
	'history_removed',
	'history_reopened',
	'history_contract_created',
	'previous_invoices_imported',
	'previous_invoices_reverted',
	'previous_invoice_client_linked',
	'history_registered',
	'quick_start_applied',
] as const;
export type OnboardingEventType = (typeof ONBOARDING_EVENT_TYPES)[number];

export interface OnboardingEventInput {
	type: OnboardingEventType;
	lineKey?: string | null;
	entityType?: string | null;
	entityId?: string | null;
	payload?: Record<string, unknown>;
}

/** Inserta un evento en la transacción del cambio (con la marca `sapira.writer` ya fijada por `withApiWriter`). */
export async function insertOnboardingEvent(runner: Queryable, holdingId: string, actorId: string, event: OnboardingEventInput) {
	await runner.query(
		`INSERT INTO onboarding_events (holding_id, type, line_key, entity_type, entity_id, payload, actor_id)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
		[
			holdingId,
			event.type,
			event.lineKey ?? null,
			event.entityType ?? null,
			event.entityId ?? null,
			JSON.stringify(event.payload ?? {}),
			actorId || null,
		]
	);
}

/** Evento leído para la API (la clave de línea sale codificada, como la usa la URL). */
/**
 * Lee `onboarding_events` tolerando que la tabla aún no exista (migración `1791900000000` sin aplicar, 14-10): en ese caso el
 * registro de cambios viene vacío y el resto del detalle se muestra igual. Un error distinto se propaga.
 */
export async function queryEvents(db: Queryable, sql: string, params: unknown[]): Promise<Row[]> {
	try {
		return (await db.query(sql, params)) as Row[];
	} catch (error) {
		const code = (error as { code?: string })?.code;
		const message = String((error as { message?: string })?.message ?? '');

		if (code === '42P01' || /onboarding_events.*(does not exist|no existe)/.test(message)) return [];
		throw error;
	}
}

export function eventDto(row: Row) {
	const raw = str(row.line_key);
	const parts = raw ? parseRawLineKey(raw) : null;

	return {
		id: String(row.id),
		type: String(row.type),
		line_key: parts ? encodeLineKey(parts) : null,
		entity_type: str(row.entity_type),
		entity_id: str(row.entity_id),
		payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) ?? {},
		actor: row.actor_id ? { id: String(row.actor_id), name: str(row.actor_name) } : null,
		created_at: row.created_at instanceof Date ? row.created_at.toISOString() : str(row.created_at),
	};
}

/** Normaliza un RUT / tax id para comparar: sin puntos, guiones ni espacios, en mayúsculas. */
export const normalizeTaxId = (value: unknown): string =>
	String(value ?? '')
		.replace(/[\s.\-/]/g, '')
		.toUpperCase();
/** Normaliza un nombre para comparar: minúsculas, espacios colapsados (nombre exacto, sin fuzzy). */
export const normalizeName = (value: unknown): string =>
	String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
/** Misma normalización en SQL (para comparar columnas). */
export const normalizeNameSql = (column: string) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
export const normalizeTaxIdSql = (column: string) => `upper(regexp_replace(COALESCE(${column}, ''), '[\\s.\\-/]', '', 'g'))`;

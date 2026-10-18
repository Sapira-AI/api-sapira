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

// ── Clave de registro de MRR histórico ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Identidad de un registro de MRR histórico (§3.1, Domi 18-10, definitivo): **registro** = `mrr_legacy.batch_id` × cliente comercial ×
 * moneda de contrato × contrato (`contract_id` = `migrated_to_contract_id`, `null` para el registro sin contrato). Es "un MRR legacy": las
 * facturas que la usuaria registró de una vez para un cliente, con uno o varios productos (lo que el front anterior agrupaba por
 * `batch_id`), y la unidad que se convierte en un contrato. `batch_id` **no** es el lote de importación de facturas previas
 * (`invoices_legacy.import_batch_id`): es el id del registro. Cada registro tiene un solo estado: con contrato es `linked`; sin contrato,
 * `pending` si tiene filas sin marcar, si no `closed` ("No activado").
 */
export interface LineKeyParts {
	batch_id: string;
	client_id: string;
	contract_currency: string;
	/** Contrato relacionado del registro; `null` = registro sin contrato (pendiente o no activado). */
	contract_id: string | null;
}

/** La raíz del registro (sin el contrato): lo que identifica el registro en `onboarding_events.line_key` antes y después de empalmarlo. */
export type RootKeyParts = Omit<LineKeyParts, 'contract_id'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clave cruda de la raíz `batch_id|client_id|contract_currency` (la que se guarda en `onboarding_events.line_key`). */
export const rawRootKey = (parts: RootKeyParts): string => `${parts.batch_id}|${parts.client_id}|${parts.contract_currency}`;

/** Clave cruda del registro `batch_id|client_id|contract_currency|<contract_id o vacío>`. */
export const rawLineKey = (parts: LineKeyParts): string => `${rawRootKey(parts)}|${parts.contract_id ?? ''}`;

const b64 = (raw: string): string => Buffer.from(raw, 'utf8').toString('base64url');

/** Clave segura para la URL: base64url de la clave cruda del registro. */
export const encodeLineKey = (parts: LineKeyParts): string => b64(rawLineKey(parts));

/** Clave de la raíz para la URL (tres partes): la acepta `GET /onboarding/events?lineKey=`. */
export const encodeRootKey = (parts: RootKeyParts): string => b64(rawRootKey(parts));

/** Raíz de un registro (sin el contrato). */
export const rootOf = (parts: LineKeyParts): RootKeyParts => ({
	batch_id: parts.batch_id,
	client_id: parts.client_id,
	contract_currency: parts.contract_currency,
});

const CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * Clave cruda → raíz (3 partes) o registro (4 partes). `null` si no calza: `batch_id` y `client_id` UUID, moneda de 3 letras y, si viene,
 * contrato UUID o vacío. La clave anterior al 18-10 (`client_id|product_name|contract_currency[|contract]`) no calza y se rechaza.
 */
function parseRaw(raw: string): LineKeyParts | null {
	const segments = raw.split('|');

	if (segments.length < 3 || segments.length > 4) return null;
	const [batch, client, currency, contract = ''] = segments;

	if (!UUID_RE.test(batch) || !UUID_RE.test(client) || !CURRENCY_RE.test(currency) || (contract !== '' && !UUID_RE.test(contract))) return null;

	return { batch_id: batch, client_id: client, contract_currency: currency, contract_id: contract || null };
}

/** Clave cruda de registro (4 partes) → partes; `null` si no calza (una raíz de 3 partes tampoco es un registro). */
export function parseRawLineKey(raw: string): LineKeyParts | null {
	return raw.split('|').length === 4 ? parseRaw(raw) : null;
}

const invalidKey = (field: string) =>
	new BadRequestException({ message: 'Registro inválido', errors: [{ field, message: 'La clave del registro no es válida' }] });

const rawOf = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key ?? '') ? Buffer.from(key, 'base64url').toString('utf8') : '');

/** Clave de la URL → partes del registro (4 partes); 400 si no es una clave válida (nunca llega SQL con una clave rota). */
export function decodeLineKey(key: string, field = 'key'): LineKeyParts {
	const parts = parseRawLineKey(rawOf(key));

	if (!parts) throw invalidKey(field);

	return parts;
}

/** Clave de la URL → raíz: acepta la clave de un registro (4 partes) o de su raíz (3); 400 si no calza. */
export function decodeRootKey(key: string, field = 'lineKey'): RootKeyParts {
	const parts = parseRaw(rawOf(key));

	if (!parts) throw invalidKey(field);

	return rootOf(parts);
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
	'history_reopened',
	'history_unified',
	'history_contract_created',
	'previous_invoices_imported',
	'previous_invoices_reverted',
	'previous_invoice_client_linked',
	'history_registered',
	'quick_start_applied',
	'previous_invoice_adopted',
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

/**
 * Evento leído para la API. `line_key` es la **raíz** del registro codificada (tres partes, `batch_id|client_id|contract_currency`): el
 * historial sigue al registro aunque se empalme o se desvincule. Un `line_key` guardado con otra forma (claves anteriores al 18-10) sale
 * `null`.
 */
export function eventDto(row: Row) {
	const raw = str(row.line_key);
	const parts = raw ? parseRaw(raw) : null;

	return {
		id: String(row.id),
		type: String(row.type),
		line_key: parts ? encodeRootKey(rootOf(parts)) : null,
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

import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import type { PermissionContext } from '@/guards/permissions.service';

export type Row = Record<string, unknown>;
export type Queryable = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;

/** Request tras `SupabaseAuthGuard` + `HoldingScopeGuard` + `RequirePermissionGuard`. */
export interface SettingsRequest {
	user?: { sub?: string; id?: string };
	permissionContext?: PermissionContext;
}

export const authIdOf = (req: SettingsRequest): string => String(req.user?.sub ?? req.user?.id ?? '');

export const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Fecha pura de Postgres (`date` llega como Date o string según el driver) → `YYYY-MM-DD`. */
export function toIsoDate(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) {
		const y = value.getFullYear();
		const m = String(value.getMonth() + 1).padStart(2, '0');
		const d = String(value.getDate()).padStart(2, '0');

		return `${y}-${m}-${d}`;
	}

	return String(value).slice(0, 10);
}

/** `YYYY-MM-DD` → `DD-MM-YYYY` para mensajes. */
export const displayDate = (iso: string | null): string => (iso ? iso.split('-').reverse().join('-') : '');

export const toNumber = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Number(value));

export const toCount = (value: unknown): number => Number(value ?? 0) || 0;

/** `undefined` → no se toca; `''` → `null`; texto → recortado. */
export function cleanText(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const trimmed = value.trim();

	return trimmed === '' ? null : trimmed;
}

/** Postgres `unique_violation`. */
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

/** Ejecuta un INSERT/UPDATE y traduce la violación de unicidad a un 409 con mensaje propio. */
export async function withUniqueMessage<T>(work: () => Promise<T>, message: string): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isUniqueViolation(error)) throw new ConflictException(message);
		throw error;
	}
}

/** Moneda activa del catálogo `currencies` (código en mayúsculas). 400 si no existe. */
export async function assertCurrency(db: Queryable, code: string, field = 'currency'): Promise<string> {
	const normalized = code.trim().toUpperCase();
	const rows = (await db.query(`SELECT code FROM currencies WHERE code = $1 AND is_active = true LIMIT 1`, [normalized])) as Row[];

	if (!rows.length) throw validationException([{ field, message: `Moneda no reconocida: ${normalized}` }]);

	return normalized;
}

/** Compañía del holding (404 si no). La tabla `companies` sí tiene `holding_id`. */
export async function assertCompanyInHolding(db: Queryable, holdingId: string, companyId: string): Promise<Row> {
	const [row] = (await db.query(`SELECT id, legal_name, currency FROM companies WHERE id = $1 AND holding_id = $2`, [
		companyId,
		holdingId,
	])) as Row[];

	if (!row) throw new NotFoundException('Compañía no encontrada');

	return row;
}

/** Plural simple para mensajes ("3 contratos", "1 contrato"). */
export const plural = (count: number, singular: string, pluralForm: string): string => `${count} ${count === 1 ? singular : pluralForm}`;

/** Une una lista en español: "a", "a y b", "a, b y c". */
export function joinEs(parts: string[]): string {
	if (parts.length <= 1) return parts.join('');

	return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

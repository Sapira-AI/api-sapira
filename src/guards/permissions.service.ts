import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ALL_PERMISSIONS, forbiddenMessage, INTERNAL_PERMISSION_CODES } from './permission-codes';

/** Quién opera y qué puede hacer en el holding activo. */
export interface PermissionContext {
	userId: string;
	name: string | null;
	email: string;
	isSuperAdmin: boolean;
	/** Rol del usuario solo si es del holding activo (`roles.holding_id`); si no, `null` y sin permisos. */
	roleId: string | null;
	codes: ReadonlySet<string>;
}

type Row = Record<string, unknown>;

/**
 * Permisos por rol resueltos en el holding activo (D1 de la spec Configuración v3): `user_holdings` (pertenencia activa) →
 * `users.role_id` → `roles` **del mismo holding** → `role_permissions` → `permissions`. Super admin pasa siempre; `ALL_PERMISSIONS`
 * cubre todo salvo los permisos internos (`VIEW_LAB`, `VIEW_DOCUMENTACION`). Va después de `HoldingScopeGuard`.
 */
@Injectable()
export class PermissionsService {
	constructor(private readonly dataSource: DataSource) {}

	async context(authId: string, holdingId: string): Promise<PermissionContext | null> {
		const [row] = (await this.dataSource.query(
			`SELECT u.id, u.name, u.email, COALESCE(u.is_super_admin, false) AS is_super_admin,
				r.id AS role_id,
				COALESCE((SELECT array_agg(p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
					WHERE rp.role_id = r.id), ARRAY[]::text[]) AS codes
			FROM users u
			JOIN user_holdings uh ON uh.user_id = u.id AND uh.holding_id = $2 AND uh.is_active = true
			LEFT JOIN roles r ON r.id = u.role_id AND r.holding_id = $2
			WHERE u.auth_id = $1
			LIMIT 1`,
			[authId, holdingId]
		)) as Row[];

		if (!row) return null;

		return {
			userId: String(row.id),
			name: (row.name as string | null) ?? null,
			email: String(row.email ?? ''),
			isSuperAdmin: row.is_super_admin === true,
			roleId: (row.role_id as string | null) ?? null,
			codes: new Set(((row.codes as string[] | null) ?? []).filter(Boolean)),
		};
	}

	/** `users.is_super_admin` del usuario de la sesión (no depende del holding). */
	async isSuperAdmin(authId: string): Promise<boolean> {
		if (!authId) return false;
		const [row] = (await this.dataSource.query(`SELECT COALESCE(is_super_admin, false) AS is_super_admin FROM users WHERE auth_id = $1 LIMIT 1`, [
			authId,
		])) as Row[];

		return row?.is_super_admin === true;
	}

	/** `true` si el contexto tiene **alguno** de los códigos. */
	static allows(context: PermissionContext | null, codes: readonly string[]): boolean {
		if (!context) return false;
		if (context.isSuperAdmin) return true;

		return codes.some((code) => context.codes.has(code) || (context.codes.has(ALL_PERMISSIONS) && !INTERNAL_PERMISSION_CODES.includes(code)));
	}

	/** Exige alguno de los códigos; devuelve el contexto para reutilizarlo (usuario que firma la acción). */
	async assert(authId: string, holdingId: string, codes: readonly string[]): Promise<PermissionContext> {
		const context = await this.context(authId, holdingId);

		if (!context || !PermissionsService.allows(context, codes)) throw new ForbiddenException(forbiddenMessage(codes));

		return context;
	}
}

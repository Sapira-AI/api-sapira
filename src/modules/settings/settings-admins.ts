import { ConflictException } from '@nestjs/common';

import { ALL_PERMISSIONS, PERMISSION_CODES } from '@/guards/permission-codes';

import type { Queryable, Row } from './settings-common';

export interface AdminOverride {
	/** El usuario pasaría a este rol. */
	user?: { userId: string; roleId: string };
	/** El rol pasaría a tener estos códigos. */
	role?: { roleId: string; codes: string[] };
	/** El usuario dejaría de ser miembro activo del holding (desactivar acceso). */
	leavingUserId?: string;
}

const ADMIN_CODES = [PERMISSION_CODES.editSettings, ALL_PERMISSIONS];

/**
 * Cuántos miembros activos del holding (sin contar super admins) pueden editar la configuración, opcionalmente simulando un cambio de
 * rol de un usuario, de permisos de un rol o la salida de un miembro (desactivar acceso). Lo usan Usuarios y Roles para no dejar al holding sin administradores.
 */
export async function countConfigAdmins(db: Queryable, holdingId: string, override: AdminOverride = {}): Promise<number> {
	const members = (await db.query(
		`SELECT u.id, u.role_id FROM user_holdings uh JOIN users u ON u.id = uh.user_id
		WHERE uh.holding_id = $1 AND uh.is_active = true AND COALESCE(u.is_super_admin, false) = false`,
		[holdingId]
	)) as Row[];
	const roles = (await db.query(
		`SELECT r.id, COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), ARRAY[]::text[]) AS codes
		FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
		WHERE r.holding_id = $1 GROUP BY r.id`,
		[holdingId]
	)) as Row[];
	const codesByRole = new Map(roles.map((role) => [String(role.id), new Set((role.codes as string[]) ?? [])]));

	if (override.role) codesByRole.set(override.role.roleId, new Set(override.role.codes));

	return members.filter((member) => {
		if (override.leavingUserId && override.leavingUserId === String(member.id)) return false;
		const roleId = override.user && override.user.userId === String(member.id) ? override.user.roleId : (member.role_id as string | null);
		const codes = roleId ? codesByRole.get(String(roleId)) : undefined;

		return !!codes && ADMIN_CODES.some((code) => codes.has(code));
	}).length;
}

/** 409 si el cambio deja en 0 a quienes pueden editar la configuración (cuando antes había al menos uno). */
export async function assertKeepsConfigAdmin(db: Queryable, holdingId: string, override: AdminOverride): Promise<void> {
	const before = await countConfigAdmins(db, holdingId);

	if (before === 0) return;
	if ((await countConfigAdmins(db, holdingId, override)) === 0) {
		throw new ConflictException('El holding quedaría sin nadie que pueda editar la configuración');
	}
}

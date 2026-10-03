import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { PermissionContext } from '@/guards/permissions.service';

import { assertKeepsConfigAdmin } from './settings-admins';
import { Row, toCount } from './settings-common';

const userDto = (row: Row, actor: PermissionContext) => ({
	id: String(row.id),
	name: (row.name as string | null) ?? null,
	email: String(row.email),
	status: (row.status as string | null) ?? null,
	access_active: row.access_active === true,
	last_access: row.last_access ?? null,
	last_invitation_sent_at: row.last_invitation_sent_at ?? null,
	role: row.role_id ? { id: String(row.role_id), name: String(row.role_name) } : null,
	is_super_admin: row.is_super_admin === true,
	is_self: String(row.id) === actor.userId,
	/** Holdings activos a los que pertenece (ronda 3): > 1 → su rol es único y "Cambiar rol" responde 409. */
	holdings_count: toCount(row.holdings_count),
});

/**
 * Usuarios del holding activo (spec §1.4). Pertenencia por `user_holdings`; el rol es `users.role_id` (uno por usuario, D1) y solo se
 * muestra si es de este holding. Invitar, reenviar, desactivar y eliminar invitación van al final del bloque (D5/D6).
 */
@Injectable()
export class SettingsUsersService {
	constructor(private readonly dataSource: DataSource) {}

	private readonly select = `SELECT u.id, u.name, u.email, u.status, u.last_access, u.last_invitation_sent_at,
		COALESCE(u.is_super_admin, false) AS is_super_admin, uh.is_active AS access_active, r.id AS role_id, r.name AS role_name,
		(SELECT count(*) FROM user_holdings x WHERE x.user_id = u.id AND x.is_active = true) AS holdings_count
		FROM user_holdings uh
		JOIN users u ON u.id = uh.user_id
		LEFT JOIN roles r ON r.id = u.role_id AND r.holding_id = uh.holding_id`;

	async list(holdingId: string, actor: PermissionContext) {
		const rows = (await this.dataSource.query(
			`${this.select} WHERE uh.holding_id = $1 ${actor.isSuperAdmin ? '' : 'AND COALESCE(u.is_super_admin, false) = false'}
			ORDER BY lower(COALESCE(u.name, u.email))`,
			[holdingId]
		)) as Row[];

		return rows.map((row) => userDto(row, actor));
	}

	async changeRole(holdingId: string, userId: string, roleId: string, actor: PermissionContext) {
		const [user] = (await this.dataSource.query(`${this.select} WHERE uh.holding_id = $1 AND u.id = $2`, [holdingId, userId])) as Row[];

		if (!user || (user.is_super_admin === true && !actor.isSuperAdmin)) throw new NotFoundException('Usuario no encontrado');
		if (user.is_super_admin === true) throw new ConflictException('El rol de un super admin no se cambia desde aquí');
		const role = (await this.dataSource.query(`SELECT id FROM roles WHERE id = $1 AND holding_id = $2`, [roleId, holdingId])) as Row[];

		if (!role.length) throw new NotFoundException('Rol no encontrado');
		const [memberships] = (await this.dataSource.query(`SELECT count(*) AS n FROM user_holdings WHERE user_id = $1 AND is_active = true`, [
			userId,
		])) as Row[];

		if (toCount(memberships?.n) > 1) {
			throw new ConflictException('Este usuario pertenece a más de un holding y su rol es único: cámbialo desde soporte');
		}
		await assertKeepsConfigAdmin(this.dataSource, holdingId, { user: { userId, roleId } });
		await this.dataSource.query(`UPDATE users SET role_id = $2 WHERE id = $1`, [userId, roleId]);
		const [updated] = (await this.dataSource.query(`${this.select} WHERE uh.holding_id = $1 AND u.id = $2`, [holdingId, userId])) as Row[];

		return userDto(updated, actor);
	}
}

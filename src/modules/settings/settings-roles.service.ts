import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { ALL_PERMISSIONS, INTERNAL_PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import {
	NotificationsService,
	ROLE_SUBSCRIPTION_NOTIFICATION_LABELS,
	ROLE_SUBSCRIPTION_NOTIFICATION_TYPES,
} from '@/modules/notifications/notifications.service';

import { INTERNAL_PERMISSION_LABELS, isGrantable, PERMISSION_MODULES, SPECIAL_PERMISSIONS, visibleCodes } from './permissions-catalog';
import { assertKeepsConfigAdmin } from './settings-admins';
import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type { CreateRoleDto, DuplicateRoleDto, UpdateRoleDto } from './dtos/roles.dto';

const DUPLICATE_NAME = 'Ya existe un rol con ese nombre';

const roleDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name),
	description: (row.description as string | null) ?? null,
	is_default: row.is_default === true,
	users_count: toCount(row.users_count),
	permissions: ((row.permissions as string[] | null) ?? []).filter(Boolean).sort(),
	created_at: row.created_at,
});

/**
 * Roles y permisos (spec §1.4, D7): roles por defecto (`roles.is_default`, M9) no se editan ni se borran; los propios sí (crear, editar,
 * duplicar, eliminar si no tiene usuarios). Quien no es super admin no ve ni otorga permisos internos ni el comodín, y al editar un rol
 * se conservan los códigos que no puede ver (internos, heredados). Nunca se deja al holding sin alguien que edite la configuración.
 */
@Injectable()
export class SettingsRolesService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly notifications: NotificationsService
	) {}

	private async catalog(): Promise<Map<string, string>> {
		const rows = (await this.dataSource.query(`SELECT id, code FROM permissions`)) as Row[];

		return new Map(rows.map((row) => [String(row.code), String(row.id)]));
	}

	async permissionsCatalog(actor: PermissionContext) {
		const catalog = new Set((await this.catalog()).keys());
		const pick = (code: string | null) => (code && catalog.has(code) ? { code, label: code.startsWith('VIEW_') ? 'Ver' : 'Editar' } : null);

		return {
			modules: PERMISSION_MODULES.map((module) => ({
				key: module.key,
				label: module.label,
				view: pick(module.view),
				edit: pick(module.edit),
				...(module.note ? { note: module.note } : {}),
			})),
			special: SPECIAL_PERMISSIONS.filter((permission) => catalog.has(permission.code)),
			internal: actor.isSuperAdmin
				? Object.entries(INTERNAL_PERMISSION_LABELS)
						.filter(([code]) => catalog.has(code))
						.map(([code, label]) => ({ code, label }))
				: [],
		};
	}

	private readonly roleSelect = `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
		(SELECT count(*) FROM users u WHERE u.role_id = r.id) AS users_count,
		COALESCE((SELECT array_agg(p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id),
			ARRAY[]::text[]) AS permissions
		FROM roles r`;

	async list(holdingId: string) {
		const rows = (await this.dataSource.query(`${this.roleSelect} WHERE r.holding_id = $1 ORDER BY r.is_default DESC, lower(r.name)`, [
			holdingId,
		])) as Row[];

		return rows.map(roleDto);
	}

	private async findRow(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${this.roleSelect} WHERE r.id = $1 AND r.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Rol no encontrado');

		return row;
	}

	async get(holdingId: string, id: string) {
		return roleDto(await this.findRow(holdingId, id));
	}

	/**
	 * Lista final de códigos: lo pedido (validado contra el catálogo y lo que el usuario puede otorgar) más lo que el rol ya tenía y el
	 * usuario no ve (internos, comodín, heredados), para no quitarlo sin querer.
	 */
	private resolveCodes(requested: string[], existing: string[], catalog: Map<string, string>, actor: PermissionContext): string[] {
		const unique = [...new Set(requested)];
		const invalid = unique.filter((code) => !catalog.has(code) || !isGrantable(code, actor.isSuperAdmin));

		if (invalid.length) throw validationException([{ field: 'permissions', message: `Permiso no válido: ${invalid.join(', ')}` }]);
		const hidden = existing.filter((code) => !isGrantable(code, actor.isSuperAdmin));

		return [...new Set([...unique, ...hidden])];
	}

	private async writePermissions(manager: EntityManager, holdingId: string, roleId: string, codes: string[], catalog: Map<string, string>) {
		await manager.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
		const ids = codes.map((code) => catalog.get(code)).filter((id): id is string => !!id);

		if (ids.length) {
			await manager.query(
				`INSERT INTO role_permissions (role_id, permission_id, holding_id) SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`,
				[roleId, ids, holdingId]
			);
		}
	}

	async create(holdingId: string, dto: CreateRoleDto, actor: PermissionContext) {
		const catalog = await this.catalog();
		const codes = this.resolveCodes(dto.permissions, [], catalog, actor);
		const id = await withUniqueMessage(
			() =>
				this.dataSource.transaction(async (manager) => {
					const [row] = (await manager.query(
						`INSERT INTO roles (name, description, holding_id, is_default) VALUES ($1, $2, $3, false) RETURNING id`,
						[dto.name, dto.description ?? null, holdingId]
					)) as Row[];

					await this.writePermissions(manager, holdingId, String(row.id), codes, catalog);

					return String(row.id);
				}),
			DUPLICATE_NAME
		);

		return this.get(holdingId, id);
	}

	async update(holdingId: string, id: string, dto: UpdateRoleDto, actor: PermissionContext) {
		const current = await this.findRow(holdingId, id);

		if (current.is_default === true) throw new ConflictException('Los roles por defecto no se editan: duplícalo para personalizarlo');
		const catalog = await this.catalog();
		const codes =
			dto.permissions === undefined ? null : this.resolveCodes(dto.permissions, (current.permissions as string[]) ?? [], catalog, actor);

		if (codes) await assertKeepsConfigAdmin(this.dataSource, holdingId, { role: { roleId: id, codes } });
		await withUniqueMessage(
			() =>
				this.dataSource.transaction(async (manager) => {
					await manager.query(`UPDATE roles SET name = $3, description = $4 WHERE id = $1 AND holding_id = $2`, [
						id,
						holdingId,
						dto.name ?? current.name,
						dto.description === undefined ? (current.description ?? null) : dto.description,
					]);
					if (codes) await this.writePermissions(manager, holdingId, id, codes, catalog);
				}),
			DUPLICATE_NAME
		);

		return this.get(holdingId, id);
	}

	async remove(holdingId: string, id: string): Promise<void> {
		const current = await this.findRow(holdingId, id);

		if (current.is_default === true) throw new ConflictException('Los roles por defecto no se eliminan');
		const users = toCount(current.users_count);

		if (users > 0) {
			throw new ConflictException(`El rol tiene ${plural(users, 'usuario', 'usuarios')}: asígnales otro rol antes de eliminarlo`);
		}
		await this.dataSource.transaction(async (manager) => {
			await manager.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
			// notification_role_subscriptions se borra en cascada (FK ON DELETE CASCADE).
			await manager.query(`DELETE FROM roles WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
		});
	}

	async duplicate(holdingId: string, id: string, dto: DuplicateRoleDto, actor: PermissionContext) {
		const source = await this.findRow(holdingId, id);
		const catalog = await this.catalog();
		let codes = ((source.permissions as string[]) ?? []).filter(Boolean);

		if (!actor.isSuperAdmin) {
			// El comodín se expande a los códigos visibles: así la copia es editable en la matriz. Los internos no se copian.
			if (codes.includes(ALL_PERMISSIONS))
				codes = [...codes.filter((code) => code !== ALL_PERMISSIONS), ...visibleCodes(new Set(catalog.keys()))];
			codes = codes.filter((code) => !INTERNAL_PERMISSION_CODES.includes(code));
		}
		const name = dto.name ?? (await this.freeCopyName(holdingId, String(source.name)));
		const newId = await withUniqueMessage(
			() =>
				this.dataSource.transaction(async (manager) => {
					const [row] = (await manager.query(
						`INSERT INTO roles (name, description, holding_id, is_default) VALUES ($1, $2, $3, false) RETURNING id`,
						[name, source.description ?? null, holdingId]
					)) as Row[];

					await this.writePermissions(manager, holdingId, String(row.id), [...new Set(codes)], catalog);

					return String(row.id);
				}),
			DUPLICATE_NAME
		);

		return this.get(holdingId, newId);
	}

	private async freeCopyName(holdingId: string, base: string): Promise<string> {
		const rows = (await this.dataSource.query(`SELECT name FROM roles WHERE holding_id = $1`, [holdingId])) as Row[];
		const taken = new Set(rows.map((row) => String(row.name)));
		let candidate = `${base} (copia)`;

		for (let index = 2; taken.has(candidate); index++) candidate = `${base} (copia ${index})`;

		return candidate;
	}

	// ── Alertas del rol ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	async getAlerts(holdingId: string, id: string) {
		await this.findRow(holdingId, id);
		const enabled = new Set(await this.notifications.listRoleSubscriptionTypes(holdingId, id));

		return {
			role_id: id,
			alerts: ROLE_SUBSCRIPTION_NOTIFICATION_TYPES.map((type) => ({
				type,
				label: ROLE_SUBSCRIPTION_NOTIFICATION_LABELS[type] ?? type,
				enabled: enabled.has(type),
			})),
		};
	}

	async putAlerts(holdingId: string, id: string, types: string[]) {
		await this.findRow(holdingId, id);
		const invalid = types.filter((type) => !ROLE_SUBSCRIPTION_NOTIFICATION_TYPES.includes(type));

		if (invalid.length) throw validationException([{ field: 'types', message: `Tipo de alerta no válido: ${invalid.join(', ')}` }]);
		await this.notifications.replaceRoleSubscriptionTypes(holdingId, id, types);

		return this.getAlerts(holdingId, id);
	}
}

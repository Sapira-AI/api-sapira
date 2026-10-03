import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { PermissionContext } from '@/guards/permissions.service';
import type { NotificationsService } from '@/modules/notifications/notifications.service';

import { fakeDb, Handler } from './fake-db.testing-spec';
import { countConfigAdmins } from './settings-admins';
import { SettingsRolesService } from './settings-roles.service';
import { SettingsUsersService } from './settings-users.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ROLE = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ROLE = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';

const admin: PermissionContext = { userId: 'me', name: 'Yo', email: 'yo@x', isSuperAdmin: false, roleId: ROLE, codes: new Set(['ALL_PERMISSIONS']) };
const superAdmin: PermissionContext = { ...admin, isSuperAdmin: true };

const CATALOG = [
	'VIEW_CLIENTES',
	'EDIT_CLIENTES',
	'VIEW_CONFIGURACION',
	'EDIT_CONFIGURACION',
	'CLOSE_PERIODS',
	'ALL_PERMISSIONS',
	'VIEW_DOCUMENTACION',
	'VIEW_REPORTS',
	'VIEW_CONTRATOS',
];
const catalog: Handler = ['SELECT id, code FROM permissions', () => CATALOG.map((code) => ({ id: `p-${code}`, code }))];

/** Miembros y roles para la regla "no dejar al holding sin administradores". */
const admins = (members: { id: string; role_id: string }[], roles: { id: string; codes: string[] }[]): Handler[] => [
	['FROM user_holdings uh JOIN users u ON u.id = uh.user_id WHERE uh.holding_id = $1 AND uh.is_active = true AND COALESCE', () => members],
	['FROM roles r LEFT JOIN role_permissions rp', () => roles],
];

describe('countConfigAdmins', () => {
	it('cuenta miembros cuyo rol tiene EDIT_CONFIGURACION o ALL_PERMISSIONS, simulando cambios', async () => {
		const db = fakeDb(
			admins(
				[
					{ id: 'u1', role_id: ROLE },
					{ id: 'u2', role_id: OTHER_ROLE },
				],
				[
					{ id: ROLE, codes: ['ALL_PERMISSIONS'] },
					{ id: OTHER_ROLE, codes: ['VIEW_CLIENTES'] },
				]
			)
		);

		await expect(countConfigAdmins(db, HOLDING)).resolves.toBe(1);
		await expect(countConfigAdmins(db, HOLDING, { user: { userId: 'u1', roleId: OTHER_ROLE } })).resolves.toBe(0);
		await expect(countConfigAdmins(db, HOLDING, { role: { roleId: OTHER_ROLE, codes: ['EDIT_CONFIGURACION'] } })).resolves.toBe(2);
	});
});

describe('SettingsRolesService', () => {
	const notifications = {
		listRoleSubscriptionTypes: jest.fn(async () => ['invoice_odoo_failure']),
		replaceRoleSubscriptionTypes: jest.fn(async () => []),
	};
	const build = (handlers: Handler[] = []) => {
		const db = fakeDb([...handlers, catalog]);

		return { db, service: new SettingsRolesService(db as unknown as DataSource, notifications as unknown as NotificationsService) };
	};
	const roleRow = (extra: Record<string, unknown> = {}) =>
		[
			'WHERE r.id = $1 AND r.holding_id = $2',
			(params: unknown[]) =>
				params[1] === HOLDING
					? [{ id: params[0], name: 'Custom', is_default: false, users_count: 0, permissions: ['VIEW_CLIENTES'], ...extra }]
					: [],
		] as Handler;

	it('catálogo: internos solo para super admin', async () => {
		const { service } = build();
		const forAdmin = await service.permissionsCatalog(admin);
		const forSuper = await service.permissionsCatalog(superAdmin);

		expect(forAdmin.internal).toEqual([]);
		expect(forSuper.internal.map((permission) => permission.code)).toEqual(['ALL_PERMISSIONS', 'VIEW_DOCUMENTACION']);
		expect(forAdmin.special).toEqual([{ code: 'CLOSE_PERIODS', label: 'Cerrar y reabrir períodos contables' }]);
		expect(forAdmin.modules.find((module) => module.key === 'clientes')).toMatchObject({
			view: { code: 'VIEW_CLIENTES' },
			edit: { code: 'EDIT_CLIENTES' },
		});
		// Códigos que no existen en el catálogo no se ofrecen.
		expect(forAdmin.modules.find((module) => module.key === 'facturacion')).toMatchObject({ view: null, edit: null });
	});

	it('roles por defecto: no se editan ni se eliminan', async () => {
		const { service } = build([roleRow({ is_default: true })]);

		await expect(service.update(HOLDING, ROLE, { name: 'X' }, admin)).rejects.toThrow(
			'Los roles por defecto no se editan: duplícalo para personalizarlo'
		);
		await expect(service.remove(HOLDING, ROLE)).rejects.toThrow('Los roles por defecto no se eliminan');
	});

	it('permiso inexistente, interno o heredado → 400 para quien no es super admin', async () => {
		const { service } = build();

		for (const code of ['NO_EXISTE', 'VIEW_DOCUMENTACION', 'ALL_PERMISSIONS', 'VIEW_REPORTS']) {
			await expect(service.create(HOLDING, { name: 'R', permissions: [code] }, admin)).rejects.toThrow(`Permiso no válido: ${code}`);
		}
	});

	it('crear escribe el rol propio y sus permisos en una transacción', async () => {
		const { db, service } = build([['INSERT INTO roles', () => [{ id: ROLE }]], roleRow()]);

		await service.create(HOLDING, { name: 'Cobranza', permissions: ['VIEW_CLIENTES', 'VIEW_CLIENTES'] }, admin);
		expect(db.statements('INSERT INTO roles')[0].params).toEqual(['Cobranza', null, HOLDING]);
		expect(db.statements('INSERT INTO role_permissions')[0].params).toEqual([ROLE, ['p-VIEW_CLIENTES'], HOLDING]);
	});

	it('editar conserva los códigos que el usuario no ve (internos, heredados)', async () => {
		const { db, service } = build([roleRow({ permissions: ['VIEW_CLIENTES', 'VIEW_DOCUMENTACION', 'VIEW_REPORTS'] }), ...admins([], [])]);

		await service.update(HOLDING, ROLE, { permissions: ['EDIT_CLIENTES'] }, admin);
		expect((db.statements('INSERT INTO role_permissions')[0].params[1] as string[]).sort()).toEqual([
			'p-EDIT_CLIENTES',
			'p-VIEW_CLIENTES',
			'p-VIEW_DOCUMENTACION',
			'p-VIEW_REPORTS',
		]);
	});

	it('quitar EDIT_CONFIGURACION al único rol administrador → 409', async () => {
		const { db, service } = build([
			roleRow({ permissions: ['EDIT_CONFIGURACION'] }),
			...admins([{ id: 'me', role_id: ROLE }], [{ id: ROLE, codes: ['EDIT_CONFIGURACION'] }]),
		]);

		await expect(service.update(HOLDING, ROLE, { permissions: ['VIEW_CONFIGURACION'] }, admin)).rejects.toThrow(
			new ConflictException('El holding quedaría sin nadie que pueda editar la configuración')
		);
		expect(db.statements('DELETE FROM role_permissions')).toHaveLength(0);
	});

	it('eliminar un rol con usuarios → 409; sin usuarios borra permisos y rol', async () => {
		await expect(build([roleRow({ users_count: 3 })]).service.remove(HOLDING, ROLE)).rejects.toThrow(
			'El rol tiene 3 usuarios: asígnales otro rol antes de eliminarlo'
		);
		const { db, service } = build([roleRow()]);

		await service.remove(HOLDING, ROLE);
		expect(db.statements('DELETE FROM roles')[0].params).toEqual([ROLE, HOLDING]);
	});

	it('rol de otro holding → 404', async () => {
		const { service } = build([roleRow()]);

		await expect(service.get('99999999-9999-4999-8999-999999999999', ROLE)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('duplicar Administrador sin ser super admin: el comodín se expande a códigos visibles y los internos no se copian', async () => {
		const { db, service } = build([
			roleRow({ name: 'Administrador', is_default: true, permissions: ['ALL_PERMISSIONS', 'VIEW_DOCUMENTACION'] }),
			['SELECT name FROM roles WHERE holding_id', () => [{ name: 'Administrador' }, { name: 'Administrador (copia)' }]],
			['INSERT INTO roles', () => [{ id: OTHER_ROLE }]],
		]);

		await service.duplicate(HOLDING, ROLE, {}, admin);
		expect(db.statements('INSERT INTO roles')[0].params[0]).toBe('Administrador (copia 2)');
		const ids = db.statements('INSERT INTO role_permissions')[0].params[1] as string[];

		expect(ids).not.toContain('p-ALL_PERMISSIONS');
		expect(ids).not.toContain('p-VIEW_DOCUMENTACION');
		expect(ids).toEqual(expect.arrayContaining(['p-VIEW_CLIENTES', 'p-EDIT_CONFIGURACION', 'p-CLOSE_PERIODS', 'p-VIEW_CONTRATOS']));
	});

	it('Editar incluye Ver: crear con EDIT_X agrega VIEW_X', async () => {
		const { db, service } = build([['INSERT INTO roles', () => [{ id: ROLE }]], roleRow()]);

		await service.create(HOLDING, { name: 'Cobranza', permissions: ['EDIT_CLIENTES', 'EDIT_CONFIGURACION'] }, admin);
		expect((db.statements('INSERT INTO role_permissions')[0].params[1] as string[]).sort()).toEqual([
			'p-EDIT_CLIENTES',
			'p-EDIT_CONFIGURACION',
			'p-VIEW_CLIENTES',
			'p-VIEW_CONFIGURACION',
		]);
	});

	it('duplicar filtra los códigos no otorgables (heredados como VIEW_REPORTS) aunque no haya comodín', async () => {
		const { db, service } = build([
			roleRow({ name: 'Antiguo', permissions: ['VIEW_CLIENTES', 'VIEW_REPORTS', 'VIEW_DOCUMENTACION'] }),
			['SELECT name FROM roles WHERE holding_id', () => [{ name: 'Antiguo' }]],
			['INSERT INTO roles', () => [{ id: OTHER_ROLE }]],
		]);

		await service.duplicate(HOLDING, ROLE, {}, admin);
		expect(db.statements('INSERT INTO role_permissions')[0].params[1]).toEqual(['p-VIEW_CLIENTES']);
	});

	it('alertas: lista los 3 tipos con su estado y reemplaza solo las del rol', async () => {
		const { service } = build([roleRow()]);
		const alerts = await service.getAlerts(HOLDING, ROLE);

		expect(alerts.alerts.map((alert) => [alert.type, alert.enabled])).toEqual([
			['salesforce_staging_blocked', false],
			['salesforce_sync_failure', false],
			['invoice_odoo_failure', true],
		]);
		await expect(service.putAlerts(HOLDING, ROLE, ['otra'])).rejects.toThrow('Tipo de alerta no válido: otra');
		await service.putAlerts(HOLDING, ROLE, ['salesforce_sync_failure']);
		expect(notifications.replaceRoleSubscriptionTypes).toHaveBeenCalledWith(HOLDING, ROLE, ['salesforce_sync_failure']);
	});
});

describe('SettingsUsersService', () => {
	const member = (extra: Record<string, unknown> = {}) => ({
		id: USER,
		name: 'Luis',
		email: 'l@x',
		status: 'Activo',
		access_active: true,
		role_id: OTHER_ROLE,
		role_name: 'Ventas',
		is_super_admin: false,
		...extra,
	});
	const build = (handlers: Handler[]) => {
		const db = fakeDb(handlers);

		return { db, service: new SettingsUsersService(db as unknown as DataSource) };
	};

	it('la lista excluye super admins salvo que consulte uno', async () => {
		const { db, service } = build([['FROM user_holdings uh JOIN users u', () => [member()]]]);

		await service.list(HOLDING, admin);
		await service.list(HOLDING, superAdmin);
		expect(db.calls[0].sql).toContain('COALESCE(u.is_super_admin, false) = false');
		expect(db.calls[1].sql).not.toContain('COALESCE(u.is_super_admin, false) = false');
	});

	it('la lista trae holdings_count (holdings activos del usuario, ronda 3)', async () => {
		const { db, service } = build([['FROM user_holdings uh JOIN users u', () => [member({ holdings_count: '2' })]]]);
		const [user] = await service.list(HOLDING, admin);

		expect(user.holdings_count).toBe(2);
		expect(db.calls[0].sql).toContain('FROM user_holdings x WHERE x.user_id = u.id AND x.is_active = true');
	});

	it('cambiar rol: usuario o rol de otro holding → 404; super admin → 409; varios holdings → 409', async () => {
		await expect(build([]).service.changeRole(HOLDING, USER, ROLE, admin)).rejects.toThrow('Usuario no encontrado');
		await expect(
			build([['WHERE uh.holding_id = $1 AND u.id = $2', () => [member()]]]).service.changeRole(HOLDING, USER, ROLE, admin)
		).rejects.toThrow('Rol no encontrado');
		await expect(
			build([['WHERE uh.holding_id = $1 AND u.id = $2', () => [member({ is_super_admin: true })]]]).service.changeRole(
				HOLDING,
				USER,
				ROLE,
				superAdmin
			)
		).rejects.toThrow('El rol de un super admin no se cambia desde aquí');
		await expect(
			build([
				['WHERE uh.holding_id = $1 AND u.id = $2', () => [member()]],
				['SELECT id FROM roles WHERE id = $1 AND holding_id = $2', () => [{ id: ROLE }]],
				['FROM user_holdings WHERE user_id = $1 AND is_active', () => [{ n: 2 }]],
			]).service.changeRole(HOLDING, USER, ROLE, admin)
		).rejects.toThrow('pertenece a más de un holding');
	});

	it('cambiar el rol del último administrador → 409; con otro admin, actualiza users.role_id', async () => {
		const common: Handler[] = [
			['WHERE uh.holding_id = $1 AND u.id = $2', () => [member({ role_id: ROLE, role_name: 'Administrador' })]],
			['SELECT id FROM roles WHERE id = $1 AND holding_id = $2', () => [{ id: OTHER_ROLE }]],
			['FROM user_holdings WHERE user_id = $1 AND is_active', () => [{ n: 1 }]],
		];
		const roles = [
			{ id: ROLE, codes: ['ALL_PERMISSIONS'] },
			{ id: OTHER_ROLE, codes: ['VIEW_CLIENTES'] },
		];
		const lonely = build([...common, ...admins([{ id: USER, role_id: ROLE }], roles)]);

		await expect(lonely.service.changeRole(HOLDING, USER, OTHER_ROLE, admin)).rejects.toThrow(
			'El holding quedaría sin nadie que pueda editar la configuración'
		);
		const ok = build([
			...common,
			...admins(
				[
					{ id: USER, role_id: ROLE },
					{ id: 'u2', role_id: ROLE },
				],
				roles
			),
		]);

		await ok.service.changeRole(HOLDING, USER, OTHER_ROLE, admin);
		expect(ok.db.statements('UPDATE users SET role_id')[0].params).toEqual([USER, OTHER_ROLE]);
	});
});

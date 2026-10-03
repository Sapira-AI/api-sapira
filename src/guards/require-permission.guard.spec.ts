import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { forbiddenMessage, isLegacyPermissionCode } from './permission-codes';
import { PermissionContext, PermissionsService } from './permissions.service';
import { RequirePermission, RequirePermissionGuard } from './require-permission.guard';
import { SuperAdminOnly, SuperAdminOnlyGuard } from './super-admin-only.guard';

const H1 = '11111111-1111-4111-8111-111111111111';

const ctx = (codes: string[], extra: Partial<PermissionContext> = {}): PermissionContext => ({
	userId: 'user-1',
	name: 'Ana',
	email: 'ana@x.cl',
	isSuperAdmin: false,
	roleId: 'role-1',
	codes: new Set(codes),
	...extra,
});

class Routes {
	@RequirePermission('EDIT_CONFIGURACION')
	edit() {}

	@RequirePermission('VIEW_LAB')
	lab() {}

	@SuperAdminOnly()
	platform() {}

	open() {}
}

const contextFor = (handler: keyof Routes, request: Record<string, unknown>) =>
	({
		getHandler: () => Routes.prototype[handler],
		getClass: () => Routes,
		switchToHttp: () => ({ getRequest: () => request }),
	}) as unknown as ExecutionContext;

describe('PermissionsService.allows', () => {
	it('con el código pasa; sin él no', () => {
		expect(PermissionsService.allows(ctx(['EDIT_CONFIGURACION']), ['EDIT_CONFIGURACION'])).toBe(true);
		expect(PermissionsService.allows(ctx(['VIEW_CONFIGURACION']), ['EDIT_CONFIGURACION'])).toBe(false);
	});

	it('Editar incluye Ver en todos los módulos; Ver no incluye Editar', () => {
		expect(PermissionsService.allows(ctx(['EDIT_CONFIGURACION']), ['VIEW_CONFIGURACION'])).toBe(true);
		expect(PermissionsService.allows(ctx(['EDIT_FACTURACION']), ['VIEW_FACTURACION'])).toBe(true);
		expect(PermissionsService.allows(ctx(['EDIT_FACTURACION']), ['VIEW_CONTRATOS'])).toBe(false);
		expect(PermissionsService.allows(ctx(['VIEW_CONTRATOS']), ['EDIT_CONTRATOS'])).toBe(false);
	});

	it('basta uno de los códigos pedidos', () => {
		expect(PermissionsService.allows(ctx(['VIEW_CONTRATOS']), ['VIEW_CONFIGURACION', 'VIEW_CONTRATOS'])).toBe(true);
	});

	it('ALL_PERMISSIONS cubre todo salvo los internos', () => {
		expect(PermissionsService.allows(ctx(['ALL_PERMISSIONS']), ['CLOSE_PERIODS'])).toBe(true);
		expect(PermissionsService.allows(ctx(['ALL_PERMISSIONS']), ['VIEW_LAB'])).toBe(false);
		expect(PermissionsService.allows(ctx(['ALL_PERMISSIONS']), ['VIEW_DOCUMENTACION'])).toBe(false);
	});

	it('super admin pasa siempre, incluso internos', () => {
		expect(PermissionsService.allows(ctx([], { isSuperAdmin: true, roleId: null }), ['VIEW_LAB'])).toBe(true);
	});

	it('sin contexto (no es miembro activo) no pasa', () => {
		expect(PermissionsService.allows(null, ['VIEW_CONFIGURACION'])).toBe(false);
	});
});

describe('PermissionsService.context', () => {
	it('el rol solo cuenta si es del holding activo (join con roles.holding_id = holding)', async () => {
		const query = jest.fn(async () => [{ id: 'u1', name: 'Ana', email: 'a@x', is_super_admin: false, role_id: null, codes: [] }]);
		const service = new PermissionsService({ query } as unknown as DataSource);
		const context = await service.context('auth-1', H1);

		expect(String((query.mock.calls[0] as unknown[])[0])).toMatch(/LEFT JOIN roles r ON r\.id = u\.role_id AND r\.holding_id = \$2/);
		expect(String((query.mock.calls[0] as unknown[])[0])).toMatch(/uh\.is_active = true/);
		expect(context?.roleId).toBeNull();
		expect(PermissionsService.allows(context, ['VIEW_CONFIGURACION'])).toBe(false);
	});

	it('sin fila (no pertenece al holding) devuelve null y assert responde 403', async () => {
		const service = new PermissionsService({ query: jest.fn(async () => []) } as unknown as DataSource);

		await expect(service.context('auth-1', H1)).resolves.toBeNull();
		await expect(service.assert('auth-1', H1, ['VIEW_CONFIGURACION'])).rejects.toThrow('No tienes permiso para ver la configuración');
	});
});

describe('RequirePermissionGuard', () => {
	const permissions = { assert: jest.fn() } as unknown as PermissionsService & { assert: jest.Mock };
	const guard = new RequirePermissionGuard(new Reflector(), permissions);

	beforeEach(() => permissions.assert.mockReset());

	it('sin metadata deja pasar sin consultar', async () => {
		await expect(guard.canActivate(contextFor('open', {}))).resolves.toBe(true);
		expect(permissions.assert).not.toHaveBeenCalled();
	});

	it('exige el código de la ruta con el holding validado y deja el contexto en la request', async () => {
		const context = ctx(['EDIT_CONFIGURACION']);
		const request: Record<string, unknown> = { user: { sub: 'auth-1' }, holdingId: H1 };

		permissions.assert.mockResolvedValue(context);
		await expect(guard.canActivate(contextFor('edit', request))).resolves.toBe(true);
		expect(permissions.assert).toHaveBeenCalledWith('auth-1', H1, ['EDIT_CONFIGURACION']);
		expect(request.permissionContext).toBe(context);
	});

	it('propaga el 403 del servicio', async () => {
		permissions.assert.mockRejectedValue(new ForbiddenException(forbiddenMessage(['EDIT_CONFIGURACION'])));
		await expect(guard.canActivate(contextFor('edit', { user: { sub: 'a' }, holdingId: H1 }))).rejects.toThrow(
			'No tienes permiso para editar la configuración · pídeselo a un administrador'
		);
	});
});

describe('SuperAdminOnlyGuard', () => {
	const isSuperAdmin = jest.fn();
	const guard = new SuperAdminOnlyGuard(new Reflector(), { isSuperAdmin } as unknown as PermissionsService);

	it('super admin pasa; el resto recibe 403', async () => {
		isSuperAdmin.mockResolvedValueOnce(true);
		await expect(guard.canActivate(contextFor('platform', { user: { sub: 'auth-1' } }))).resolves.toBe(true);
		isSuperAdmin.mockResolvedValueOnce(false);
		await expect(guard.canActivate(contextFor('platform', { user: { sub: 'auth-2' } }))).rejects.toThrow(
			'Solo un super admin de Sapira puede hacer esto'
		);
	});

	it('rutas sin @SuperAdminOnly pasan', async () => {
		isSuperAdmin.mockClear();
		await expect(guard.canActivate(contextFor('open', {}))).resolves.toBe(true);
		expect(isSuperAdmin).not.toHaveBeenCalled();
	});

	it('isSuperAdmin lee users.is_super_admin por auth_id', async () => {
		const service = new PermissionsService({ query: jest.fn(async () => [{ is_super_admin: true }]) } as unknown as DataSource);

		await expect(service.isSuperAdmin('auth-1')).resolves.toBe(true);
		await expect(service.isSuperAdmin('')).resolves.toBe(false);
	});
});

describe('permission-codes', () => {
	it('reconoce los códigos heredados que no se ofrecen', () => {
		expect(['MANAGE_USERS', 'VIEW_REPORTS', 'VIEW_FINANCIAL_DATA'].map(isLegacyPermissionCode)).toEqual([true, true, true]);
		expect(isLegacyPermissionCode('VIEW_REPORTES')).toBe(false);
	});
});

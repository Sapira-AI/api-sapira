import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { PermissionsService } from '@/guards/permissions.service';

import { BILLING_PERMISSION_KEY, BILLING_PERMISSIONS, BillingPermissionGuard } from './billing-permissions.service';
import { BillingController } from './billing.controller';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';

/** Fila de `PermissionsService.context` (rol del holding activo con sus códigos); `null` = sin pertenencia activa al holding. */
function guard(row: { is_super_admin?: boolean; role_id?: string | null; codes?: string[] } | null) {
	const query = jest.fn(async () => (row ? [{ id: 'u-1', name: null, email: 'a@b.c', role_id: 'r-1', codes: [], ...row }] : []));
	const service = new PermissionsService({ query } as unknown as DataSource);

	return { query, guard: new BillingPermissionGuard(new Reflector(), service) };
}

const request = () => ({ user: { sub: 'auth-1' }, holdingId: HOLDING }) as Record<string, unknown>;
const context = (handler: (...args: never[]) => unknown, req = request()) =>
	({
		getHandler: () => handler,
		getClass: () => BillingController,
		switchToHttp: () => ({ getRequest: () => req }),
	}) as never;

describe('Permisos de Facturación (VIEW_FACTURACION / EDIT_FACTURACION + super admin)', () => {
	const proto = BillingController.prototype as unknown as Record<string, (...args: never[]) => unknown>;

	it('lecturas exigen VIEW_FACTURACION (controlador) y toda escritura EDIT_FACTURACION (ruta)', () => {
		const reflector = new Reflector();
		const required = (name: string) => reflector.getAllAndOverride(BILLING_PERMISSION_KEY, [proto[name], BillingController]);

		for (const name of [
			'invoices',
			'summary',
			'toIssue',
			'creditNotes',
			'aging',
			'invoicePayments',
			'invoiceEmails',
			'filters',
			'export',
			'collectionSettings',
		]) {
			expect([name, required(name)]).toEqual([name, BILLING_PERMISSIONS.view]);
		}
		for (const name of [
			'paymentPreview',
			'registerPayment',
			'voidPayment',
			'proforma',
			'collectionPreview',
			'collection',
			'saveCollectionSettings',
			'sendNowPreview',
			'sendNow',
			'reschedulePreview',
			'reschedule',
			'fxPreview',
			'fx',
			'erpReset',
		]) {
			expect([name, required(name)]).toEqual([name, BILLING_PERMISSIONS.edit]);
		}
	});

	it('usa PermissionsService (mismas reglas que RequirePermission): rol del holding activo, código exacto, super admin', async () => {
		const allowed = guard({ codes: ['EDIT_FACTURACION'] });
		const req = request();

		await expect(allowed.guard.canActivate(context(proto.registerPayment, req))).resolves.toBe(true);
		expect((allowed.query.mock.calls[0] as unknown[])[1]).toEqual(['auth-1', HOLDING]);
		expect(req.permissionContext).toMatchObject({ userId: 'u-1', isSuperAdmin: false });
		await expect(guard({ is_super_admin: true }).guard.canActivate(context(proto.registerPayment))).resolves.toBe(true);
		await expect(guard({ codes: ['VIEW_FACTURACION'] }).guard.canActivate(context(proto.registerPayment))).rejects.toBeInstanceOf(
			ForbiddenException
		);
		await expect(guard(null).guard.canActivate(context(proto.invoices))).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('Editar incluye Ver: EDIT_FACTURACION abre las lecturas', async () => {
		await expect(guard({ codes: ['EDIT_FACTURACION'] }).guard.canActivate(context(proto.invoices))).resolves.toBe(true);
		await expect(guard({ codes: ['VIEW_FACTURACION'] }).guard.canActivate(context(proto.invoices))).resolves.toBe(true);
	});

	it('el comodín ALL_PERMISSIONS cubre Facturación (leer y escribir)', async () => {
		await expect(guard({ codes: ['ALL_PERMISSIONS'] }).guard.canActivate(context(proto.invoices))).resolves.toBe(true);
		await expect(guard({ codes: ['ALL_PERMISSIONS'] }).guard.canActivate(context(proto.registerPayment))).resolves.toBe(true);
	});

	it('rol de otro holding (role_id null) o sin códigos → 403 con el mensaje común', async () => {
		await expect(guard({ role_id: null, codes: [] }).guard.canActivate(context(proto.invoices))).rejects.toThrow(
			'No tienes permiso para ver la facturación · pídeselo a un administrador'
		);
		await expect(guard({ codes: ['VIEW_CLIENTES'] }).guard.canActivate(context(proto.registerPayment))).rejects.toThrow(
			'No tienes permiso para editar la facturación · pídeselo a un administrador'
		);
	});

	it('sin @RequireBillingPermission no consulta', async () => {
		const { query, guard: g } = guard({ codes: [] });
		const bare = { getHandler: () => () => null, getClass: () => class {}, switchToHttp: () => ({ getRequest: request }) } as never;

		await expect(g.canActivate(bare)).resolves.toBe(true);
		expect(query).not.toHaveBeenCalled();
	});
});

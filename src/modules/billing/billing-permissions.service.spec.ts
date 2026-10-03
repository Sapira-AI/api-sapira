import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { BILLING_PERMISSION_KEY, BILLING_PERMISSIONS, BillingPermissionGuard, BillingPermissionsService } from './billing-permissions.service';
import { BillingController } from './billing.controller';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';

function guard(row: Record<string, unknown> | null) {
	const query = jest.fn(async () => (row ? [row] : []));
	const service = new BillingPermissionsService({ query } as unknown as DataSource);

	return { query, guard: new BillingPermissionGuard(new Reflector(), service) };
}

const context = (handler: (...args: never[]) => unknown) =>
	({
		getHandler: () => handler,
		getClass: () => BillingController,
		switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'auth-1' }, holdingId: HOLDING }) }),
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

	it('con el código del rol pasa; super admin pasa; sin código → 403; consulta el código exacto del holding', async () => {
		const allowed = guard({ is_super_admin: false, has_permission: true });

		await expect(allowed.guard.canActivate(context(proto.registerPayment))).resolves.toBe(true);
		expect((allowed.query.mock.calls[0] as unknown[])[1]).toEqual(['auth-1', HOLDING, 'EDIT_FACTURACION']);
		await expect(guard({ is_super_admin: true, has_permission: false }).guard.canActivate(context(proto.registerPayment))).resolves.toBe(true);
		await expect(
			guard({ is_super_admin: false, has_permission: false }).guard.canActivate(context(proto.registerPayment))
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(guard(null).guard.canActivate(context(proto.invoices))).rejects.toBeInstanceOf(ForbiddenException);
	});
});

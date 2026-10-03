import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

type Row = Record<string, unknown>;

/**
 * Permisos de Facturación v2 (spec §6.3; códigos verificados en el catálogo `permissions` de producción el 01-10): `VIEW_FACTURACION` para
 * leer y `EDIT_FACTURACION` para escribir (pagos, cobranza, proforma, recordatorios y el fan-out de la cola). Super admin pasa siempre.
 * Va después de `SupabaseAuthGuard` + `HoldingScopeGuard` (usa el holding ya validado).
 */
export const BILLING_PERMISSIONS = { view: 'VIEW_FACTURACION', edit: 'EDIT_FACTURACION' } as const;
export type BillingPermission = (typeof BILLING_PERMISSIONS)[keyof typeof BILLING_PERMISSIONS];

export const BILLING_PERMISSION_KEY = 'billing_permission';
/** Permiso que exige la ruta (o el controlador). */
export const RequireBillingPermission = (permission: BillingPermission) => SetMetadata(BILLING_PERMISSION_KEY, permission);

@Injectable()
export class BillingPermissionsService {
	constructor(private readonly dataSource: DataSource) {}

	async has(authId: string, holdingId: string, permission: BillingPermission): Promise<boolean> {
		const [row] = (await this.dataSource.query(
			`SELECT u.is_super_admin,
				EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
					WHERE rp.role_id = u.role_id AND p.code = $3) AS has_permission
			FROM users u
			JOIN user_holdings uh ON uh.user_id = u.id AND uh.holding_id = $2 AND uh.is_active = true
			WHERE u.auth_id = $1
			LIMIT 1`,
			[authId, holdingId, permission]
		)) as Row[];

		return !!row && (row.is_super_admin === true || row.has_permission === true);
	}

	async assert(authId: string, holdingId: string, permission: BillingPermission): Promise<void> {
		if (!(await this.has(authId, holdingId, permission))) {
			throw new ForbiddenException(
				permission === BILLING_PERMISSIONS.edit
					? 'No tienes permiso para editar la facturación de este holding'
					: 'No tienes permiso para ver la facturación de este holding'
			);
		}
	}
}

/** Guard de ruta: lee `@RequireBillingPermission` (ruta, si no controlador) y exige ese código del catálogo. */
@Injectable()
export class BillingPermissionGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly permissions: BillingPermissionsService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const permission = this.reflector.getAllAndOverride<BillingPermission | undefined>(BILLING_PERMISSION_KEY, [
			context.getHandler(),
			context.getClass(),
		]);

		if (!permission) return true;
		const request = context.switchToHttp().getRequest();

		await this.permissions.assert(String(request.user?.sub ?? request.user?.id ?? ''), String(request.holdingId ?? ''), permission);

		return true;
	}
}

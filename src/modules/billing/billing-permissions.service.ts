import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionsService } from '@/guards/permissions.service';

/**
 * Permisos de Facturación v2 (spec §6.3; códigos verificados en el catálogo `permissions` de producción el 01-10): `VIEW_FACTURACION` para
 * leer y `EDIT_FACTURACION` para escribir (pagos, cobranza, proforma, recordatorios y el fan-out de la cola). Presupuestos usa los mismos.
 * Va después de `SupabaseAuthGuard` + `HoldingScopeGuard` (usa el holding ya validado).
 */
export const BILLING_PERMISSIONS = { view: 'VIEW_FACTURACION', edit: 'EDIT_FACTURACION' } as const;
export type BillingPermission = (typeof BILLING_PERMISSIONS)[keyof typeof BILLING_PERMISSIONS];

export const BILLING_PERMISSION_KEY = 'billing_permission';
/** Permiso que exige la ruta (o el controlador). */
export const RequireBillingPermission = (permission: BillingPermission) => SetMetadata(BILLING_PERMISSION_KEY, permission);

/**
 * Guard de ruta: lee `@RequireBillingPermission` (ruta, si no controlador) y lo valida con `PermissionsService` (`GuardsModule`, global),
 * con las mismas reglas que `RequirePermission`: super admin pasa; `ALL_PERMISSIONS` cubre todo salvo internos; `EDIT_FACTURACION` incluye
 * `VIEW_FACTURACION`; el rol (`users.role_id`) debe ser del holding activo. Sin permiso → 403 "No tienes permiso para … · pídeselo a un
 * administrador". Deja el contexto en `request.permissionContext`, igual que `RequirePermissionGuard`.
 */
@Injectable()
export class BillingPermissionGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly permissions: PermissionsService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const permission = this.reflector.getAllAndOverride<BillingPermission | undefined>(BILLING_PERMISSION_KEY, [
			context.getHandler(),
			context.getClass(),
		]);

		if (!permission) return true;
		const request = context.switchToHttp().getRequest();

		request.permissionContext = await this.permissions.assert(
			String(request.user?.sub ?? request.user?.id ?? ''),
			String(request.holdingId ?? ''),
			[permission]
		);

		return true;
	}
}

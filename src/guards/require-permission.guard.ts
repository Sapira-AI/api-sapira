import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionsService } from './permissions.service';

export const REQUIRED_PERMISSIONS_KEY = 'required_permissions';

/**
 * Permiso que exige la ruta (o el controlador; la ruta manda). Con varios códigos basta **uno**. Se usa con
 * `@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)`.
 */
export const RequirePermission = (...codes: string[]) => SetMetadata(REQUIRED_PERMISSIONS_KEY, codes);

/**
 * Guard genérico de permisos (spec Configuración v2 §5, D4): super admin pasa; `ALL_PERMISSIONS` cubre todo salvo internos; el rol
 * (`users.role_id`) debe ser del holding activo. Sin el código → 403 "No tienes permiso para … · pídeselo a un administrador".
 * Deja el contexto en `request.permissionContext` para que el servicio firme la acción sin volver a consultar.
 * `BillingPermissionGuard` sigue igual (D12).
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly permissions: PermissionsService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const codes = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

		if (!codes?.length) return true;
		const request = context.switchToHttp().getRequest();

		request.permissionContext = await this.permissions.assert(
			String(request.user?.sub ?? request.user?.id ?? ''),
			String(request.holdingId ?? ''),
			codes
		);

		return true;
	}
}

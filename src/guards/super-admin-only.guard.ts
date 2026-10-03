import { applyDecorators, CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionsService } from './permissions.service';

export const SUPER_ADMIN_ONLY_KEY = 'super_admin_only';

/**
 * Solo super admin (`users.is_super_admin`), para operaciones de plataforma: sincronizaciones globales, envíos a todos los holdings,
 * herramientas internas (spec Configuración v2 §10). No depende del holding activo. Se usa con
 * `@UseGuards(SupabaseAuthGuard, SuperAdminOnlyGuard)` + `@SuperAdminOnly()` en la ruta o el controlador.
 * Sin super admin → 403 "Solo un super admin de Sapira puede hacer esto".
 */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_ONLY_KEY, true);

/** Atajo: marca la ruta y aplica el guard (el `SupabaseAuthGuard` debe ir antes, en el controlador). */
export const SuperAdminOnlyRoute = () => applyDecorators(SuperAdminOnly(), UseGuards(SuperAdminOnlyGuard));

@Injectable()
export class SuperAdminOnlyGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly permissions: PermissionsService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const required = this.reflector.getAllAndOverride<boolean | undefined>(SUPER_ADMIN_ONLY_KEY, [context.getHandler(), context.getClass()]);

		if (!required) return true;
		const request = context.switchToHttp().getRequest();

		if (!(await this.permissions.isSuperAdmin(String(request.user?.sub ?? request.user?.id ?? '')))) {
			throw new ForbiddenException('Solo un super admin de Sapira puede hacer esto');
		}

		return true;
	}
}

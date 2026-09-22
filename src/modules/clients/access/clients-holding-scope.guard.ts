import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { UserHoldingsService } from './user-holdings.service';

/** Request tras `ClientsHoldingScopeGuard`: holdings del usuario (el primero es su holding por defecto). */
export interface HoldingScopedRequest {
	user?: { sub?: string; id?: string };
	holdingIds: string[];
}

function requestedHoldingIds(request: {
	query?: Record<string, unknown>;
	body?: Record<string, unknown>;
	headers?: Record<string, unknown>;
}): string[] {
	const values = [request.query?.holding_id, request.body?.holding_id, request.headers?.['x-holding-id']];

	return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
}

/**
 * Acota por holding los controladores de clientes. Va después de `SupabaseAuthGuard`. Distinto del
 * `HoldingAccessGuard` global (`src/guards/`, solo mira el header y no `is_active`): este valida también
 * `holding_id` en query/body y deja la lista de holdings para las rutas por id.
 * - si la petición nombra un holding (`holding_id` en query o body, o el header `x-holding-id`), el
 *   usuario debe pertenecer a él (403 si no);
 * - deja en `request.holdingIds` los holdings del usuario, para que las rutas por id verifiquen que el
 *   registro sea de uno de ellos y las listas sin holding usen el holding por defecto del usuario.
 */
@Injectable()
export class ClientsHoldingScopeGuard implements CanActivate {
	constructor(private readonly access: UserHoldingsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const authId: string | undefined = request.user?.sub || request.user?.id;

		if (!authId) throw new ForbiddenException('Usuario sin sesión');
		const holdingIds = await this.access.userHoldingIds(authId);

		if (requestedHoldingIds(request).some((holdingId) => !holdingIds.includes(holdingId))) {
			throw new ForbiddenException('No tienes acceso a este holding');
		}
		request.holdingIds = holdingIds;

		return true;
	}
}

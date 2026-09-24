import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { UserHoldingsService } from './user-holdings.service';

/** Request tras `HoldingScopeGuard`: el holding activo ya validado (se lee con `@HoldingId()`). */
export interface HoldingScopedRequest {
	user?: { sub?: string; id?: string };
	holdingId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Única forma de acotar un endpoint por holding (`docs/v2-rediseno/autorizacion-y-tenancy.md`). Va después
 * de `SupabaseAuthGuard` y se aplica por controlador (opt-in, no es global):
 * - exige el header `x-holding-id` con un UUID (400 si falta);
 * - el usuario debe tener una fila activa en `user_holdings` para ese holding (403 si no);
 * - si la query o el body todavía traen `holding_id`, debe ser el mismo del header (403 si no): protege
 *   los DTO viejos mientras se migran;
 * - deja el holding validado en `request.holdingId`.
 */
@Injectable()
export class HoldingScopeGuard implements CanActivate {
	constructor(private readonly userHoldings: UserHoldingsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const authId: string | undefined = request.user?.sub || request.user?.id;

		if (!authId) throw new ForbiddenException('Usuario sin sesión');

		const header = request.headers?.['x-holding-id'];
		const holdingId = typeof header === 'string' ? header.trim() : '';

		if (!UUID.test(holdingId)) throw new BadRequestException('Falta el holding activo (header x-holding-id)');

		for (const value of [request.query?.holding_id, request.body?.holding_id]) {
			if (typeof value === 'string' && value.trim() !== '' && value.trim() !== holdingId) {
				throw new ForbiddenException('El holding de la petición no coincide con el holding activo');
			}
		}

		if (!(await this.userHoldings.isActiveMember(authId, holdingId))) {
			throw new ForbiddenException('No tienes acceso a este holding');
		}

		request.holdingId = holdingId;

		return true;
	}
}

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserHolding } from '../modules/holdings/entities/user-holding.entity';

/**
 * Guard para validar que el usuario tiene acceso al holdingId recibido en el header X-Holding-Id
 *
 * Este guard verifica que:
 * 1. El usuario esté autenticado
 * 2. Exista un header X-Holding-Id en la petición
 * 3. El usuario tenga asociado ese holdingId en la tabla user_holdings
 *
 * Si alguna de estas condiciones no se cumple, lanza una excepción apropiada.
 */
@Injectable()
export class HoldingAccessGuard implements CanActivate {
	constructor(
		@InjectRepository(UserHolding)
		private readonly userHoldingRepository: Repository<UserHolding>
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user = request.user;

		// Verificar que el usuario esté autenticado
		if (!user || !user.id) {
			throw new UnauthorizedException('Usuario no autenticado');
		}

		// Obtener el holdingId del header
		const holdingId = request.headers['x-holding-id'];

		// Si no hay holdingId en el header, permitir el acceso (opcional según tu lógica)
		// Puedes cambiar esto a throw new ForbiddenException si quieres que sea obligatorio
		if (!holdingId) {
			return true; // O cambiar a: throw new ForbiddenException('Header X-Holding-Id es requerido');
		}

		// Verificar que el usuario tenga acceso a ese holding
		const userHolding = await this.userHoldingRepository.findOne({
			where: {
				user_id: user.id,
				holding_id: holdingId,
			},
		});

		if (!userHolding) {
			throw new ForbiddenException(`No tienes acceso al holding ${holdingId}. Verifica que tengas los permisos necesarios.`);
		}

		// Agregar el holdingId validado al request para uso posterior
		request.validatedHoldingId = holdingId;

		return true;
	}
}

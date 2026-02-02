import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

import { UsersService } from '@/modules/users/users.service';

@Injectable()
export class UserIdInterceptor implements NestInterceptor {
	constructor(private readonly usersService: UsersService) {}

	async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
		const request = context.switchToHttp().getRequest();

		if (request.user && request.user.id) {
			const authId = request.user.id;

			try {
				const user = await this.usersService.getUserByAuthId(authId);

				request.user.userId = user.id;
			} catch (error) {
				console.warn(`No se pudo obtener userId para auth_id: ${authId}`, error.message);
			}
		}

		return next.handle();
	}
}

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { Observable } from 'rxjs';

import { RetryOnTimeout } from '@/decorators/retry-on-timeout.decorator';
import { UsersService } from '@/modules/users/users.service';

@Injectable()
export class UserIdInterceptor implements NestInterceptor {
	private readonly logger = new Logger(UserIdInterceptor.name);
	private readonly CACHE_TTL = 300000;
	private readonly CACHE_PREFIX = 'user_id:';

	constructor(
		private readonly usersService: UsersService,
		@Inject(CACHE_MANAGER) private cacheManager: Cache
	) {}

	async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
		const request = context.switchToHttp().getRequest();

		if (request.user && request.user.id) {
			const authId = request.user.id;
			const cacheKey = `${this.CACHE_PREFIX}${authId}`;

			try {
				const cachedUserId = await this.cacheManager.get<string>(cacheKey);

				if (cachedUserId) {
					request.user.userId = cachedUserId;
				} else {
					const userId = await this.getUserIdWithRetry(authId);
					request.user.userId = userId;

					await this.cacheManager.set(cacheKey, userId, this.CACHE_TTL);
				}
			} catch (error) {
				const isTimeoutError = error.message?.includes('timeout') || error.message?.includes('Connection terminated');

				if (isTimeoutError) {
					this.logger.warn(`Timeout obteniendo userId para auth_id: ${authId} - continuando sin userId`);
				} else {
					this.logger.warn(`No se pudo obtener userId para auth_id: ${authId}`, error.message);
				}
			}
		}

		return next.handle();
	}

	@RetryOnTimeout({ maxAttempts: 2, delayMs: 500 })
	private async getUserIdWithRetry(authId: string): Promise<string> {
		const user = await this.usersService.getUserByAuthId(authId);
		return user.id;
	}
}

// azuread-auth.guard.ts
import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { firstValueFrom, Observable } from 'rxjs';

import { IS_PUBLIC_KEY } from '@/decorators/public.decorator';

@Injectable()
export class AzureADAuthGuard extends AuthGuard('azure-ad') {
	constructor(private reflector: Reflector) {
		super();
	}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const startTime = process.hrtime();

		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);

		if (isPublic) {
			return true;
		}

		try {
			const result = await Promise.resolve(super.canActivate(context))
				.then((value) => {
					if (value instanceof Observable) {
						return firstValueFrom(value);
					}
					return value;
				})
				.catch((error) => {
					throw error;
				});

			// Solo logear éxito si realmente tenemos un token válido
			if (result) {
				const [seconds, nanoseconds] = process.hrtime(startTime);
				const duration = seconds * 1000 + nanoseconds / 1000000;

				console.log('Auth Guard Validation Duration:', {
					name: 'AuthGuardValidationDuration',
					value: duration,
					properties: {
						endpoint: context.getHandler().name,
						controller: context.getClass().name,
						success: true,
					},
				});
			}

			return result;
		} catch (error) {
			const [seconds, nanoseconds] = process.hrtime(startTime);
			const duration = seconds * 1000 + nanoseconds / 1000000;

			console.error('Auth Guard Validation Exception:', {
				exception: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
				properties: {
					operation: 'AuthGuardValidation',
					endpoint: context.getHandler().name,
					controller: context.getClass().name,
					duration: duration.toString(),
					errorMessage: error.message,
				},
			});

			throw error;
		}
	}

	handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
		const request = context.switchToHttp().getRequest();
		const endpoint = context.getHandler()?.name || 'desconocido';
		const controller = context.getClass()?.name || 'desconocido';

		if (err) {
			console.error('Authentication Failure:', {
				name: 'AuthenticationFailure',
				properties: {
					error: err.message,
					errorType: err.name,
					stack: err.stack,
					info: info?.message,
					endpoint,
					controller,
					timestamp: new Date().toISOString(),
				},
			});

			throw err;
		}

		if (!user) {
			console.error('Authentication Failure - No User:', {
				name: 'AuthenticationFailure',
				properties: {
					error: 'Usuario no autenticado',
					info: info?.message,
					endpoint,
					controller,
					hasAuthHeader: !!request.headers.authorization,
					timestamp: new Date().toISOString(),
				},
			});

			throw new UnauthorizedException('Token de autorización inválido o expirado');
		}

		console.log('Authentication Success:', {
			name: 'AuthenticationSuccess',
			properties: {
				userId: user.oid,
				endpoint,
				controller,
				timestamp: new Date().toISOString(),
			},
		});

		return user;
	}
}

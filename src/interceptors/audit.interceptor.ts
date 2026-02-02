import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { AuditConfigService } from '@/audit/audit-config.service';
import { AuditService } from '@/audit/audit.service';
import { DeviceInfoDto } from '@/core/dto/device-info.dto';

/**
 * Interceptor para registrar eventos de auditoría automáticamente
 * basado en las operaciones HTTP realizadas en los controladores.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
	constructor(
		private readonly auditService: AuditService,
		private readonly auditConfigService: AuditConfigService,
		@Inject(CACHE_MANAGER) private cacheManager: Cache
	) {}

	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const req = context.switchToHttp().getRequest();

		const userId = req.user?.extension_oid;

		// Si no hay un usuario autenticado o el ID no es válido, no registrar auditoría
		if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
			return next.handle();
		}

		// Obtener información de la ruta y el método
		const { url, method, params, body } = req;

		// Caso especial: Endpoint de login para registrar primer acceso diario
		if (method === 'GET' && url === '/profile/login') {
			return next.handle().pipe(
				tap(async () => {
					try {
						// Verificar si ya se ha registrado la primera actividad para este usuario en las últimas 24 horas
						const cacheKey = `first_access_${userId}`;
						const hasRegisteredFirstAccess = await this.cacheManager.get(cacheKey);

						if (!hasRegisteredFirstAccess) {
							// Registrar la primera actividad del usuario
							await this.auditService.registrarEvento(
								userId,
								'Login',
								'first_access',
								'profile/login',
								userId,
								{},
								req.deviceInfo,
								req,
								body,
								params
							);

							// Guardar en caché que ya se registró el evento (TTL: 24 horas = 86400000 ms)
							await this.cacheManager.set(cacheKey, true, 86400000);
						} else {
						}
					} catch (error) {
						throw error;
					}
				})
			);
		}

		// Verificar si este endpoint debe ser auditado según la configuración
		const shouldAudit = this.auditConfigService.shouldAuditEndpoint(url, method);

		if (!shouldAudit) {
			return next.handle();
		}

		return next.handle().pipe(
			tap(async (responseData) => {
				try {
					// Obtener un tipo de evento específico según la configuración
					const eventType = this.auditConfigService.getEventType(url, method);

					// Extraer la acción
					const action = this.mapMethodToAction(method);

					// Extraer el tipo de recurso
					const resourceType = this.extractResourceType(url);

					// Extraer ID del recurso
					const resourceId = this.extractResourceId(responseData, params) || null;

					// Obtener información del dispositivo (si está disponible)
					const deviceInfo: DeviceInfoDto = req.deviceInfo || {};

					let details = {};
					const customDetailsExtractor = this.auditConfigService.getCustomDetailsExtractor(url);
					if (customDetailsExtractor) {
						details = customDetailsExtractor(responseData, req);
					}

					await this.auditService.registrarEvento(
						userId,
						eventType,
						action,
						resourceType,
						resourceId,
						details,
						deviceInfo,
						req,
						body,
						params
					);
				} catch (error) {
					// Capturar cualquier error para evitar que afecte la respuesta principal
					console.error('Error al registrar evento de auditoría:', error);
				}
			})
		);
	}

	/**
	 * Extrae el ID del recurso del resultado o de los parámetros de la URL
	 */
	private extractResourceId(data: any, params: any): string | null {
		// Manejar respuestas de NestJS que pueden tener diferentes estructuras
		// Primero intentar obtener el ID del resultado
		if (data) {
			// Caso 1: El ID está directamente en la raíz del objeto
			if (data._id) {
				return data._id.toString();
			}

			// Caso 2: El ID está en data.id
			if (data.id) {
				return data.id.toString();
			}

			// Caso 3: Respuesta de NestJS con data.data
			if (data.data && typeof data.data === 'object') {
				if (data.data._id) {
					return data.data._id.toString();
				}
				if (data.data.id) {
					return data.data.id.toString();
				}
			}
		}

		// Si no está en el resultado, intentar obtenerlo de los parámetros
		if (params?._id) {
			return params.id;
		} else if (params?.id) {
			return params._id;
		}

		// Buscar cualquier parámetro que termine en "Id"
		for (const key in params) {
			if (key.endsWith('Id')) {
				return params[key];
			}
		}

		return null;
	}

	/**
	 * Extrae el tipo de recurso de la URL
	 */
	private extractResourceType(url: string): string {
		// Extraer el tipo de recurso de la URL
		// Por ejemplo: /investment-calls/123 -> 'investment-call'
		const parts = url.split('/').filter(Boolean);
		if (parts.length > 0) {
			// Convertir plural a singular y formatear
			const resource = parts[0];
			return resource.endsWith('s') ? resource.slice(0, -1) : resource;
		}
		return 'unknown';
	}

	/**
	 * Mapea el método HTTP a una acción de auditoría
	 */
	private mapMethodToAction(method: string): string {
		switch (method) {
			case 'POST':
				return 'create';
			case 'PUT':
			case 'PATCH':
				return 'update';
			case 'DELETE':
				return 'delete';
			default:
				return 'read';
		}
	}

	/**
	 * Extrae detalles relevantes para la auditoría
	 */
	private extractDetails(data: any, requestBody: any): any {
		if (!data) return {};

		// Extraer campos comunes que podrían ser útiles para auditoría
		const details: any = {};

		// Campos comunes a extraer del resultado
		const fieldsToExtract = ['title', 'name', 'description', 'status', 'type', 'category'];

		// Añadir campos del resultado si existen
		fieldsToExtract.forEach((field) => {
			if (data[field] !== undefined) {
				details[field] = data[field];
			}
		});

		// Añadir información sobre los campos actualizados en caso de una actualización
		if (requestBody && Object.keys(requestBody).length > 0) {
			details.updatedFields = Object.keys(requestBody);
		}

		return details;
	}
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { v4 as uuid } from 'uuid';

import { AuditService } from '@/audit/audit.service';
import {
	AuditAction,
	AuditEvent,
	BaseEvent,
	BusinessEvent,
	EventSeverity,
	EventStatus,
	EventType,
	SecurityEvent,
} from '@/core/interfaces/events/event.interface';
import { AppLoggerService } from '@/logger/app-logger.service';
import { ViolationType } from '@/security/interfaces/violation.interface';
import { SecurityService } from '@/security/services/security.service';
import { ViolationService } from '@/security/services/violation.service';
import { UserUtils } from '@/security/utils/user.utils';
import { EventNames } from '@/telemetry/constants/event-names';
import { TelemetryService } from '@/telemetry/telemetry.service';

@Injectable()
export class EventsService {
	constructor(
		private readonly logger: AppLoggerService,
		private readonly telemetry: TelemetryService,
		private readonly audit: AuditService,
		private readonly securityService: SecurityService,
		private readonly violationService: ViolationService
	) {}

	private async validateSecurityEvent(event: SecurityEvent): Promise<void> {
		// Validaciones básicas
		if (event.type !== EventType.SECURITY) {
			throw new BadRequestException('El evento debe ser de tipo SECURITY');
		}

		if (!event.violationType) {
			throw new BadRequestException('El campo violationType es requerido para eventos de seguridad');
		}

		if (!event.userId) {
			throw new BadRequestException('El campo userId es requerido para eventos de seguridad');
		}

		if (!event.ipAddress) {
			throw new BadRequestException('El campo ipAddress es requerido para eventos de seguridad');
		}

		if (!event.correlationId || !this.isValidGuid(event.correlationId)) {
			throw new BadRequestException('El campo correlationId es requerido y debe ser un GUID válido');
		}

		if (!event.timestamp || !(event.timestamp instanceof Date)) {
			throw new BadRequestException('El campo timestamp es requerido y debe ser una fecha válida');
		}

		// Validar IP usando el servicio de seguridad
		const ipStatus = await this.securityService.checkIpStatus(event.ipAddress);

		// Registrar la violación si la IP está bloqueada
		if (ipStatus.isBlocked) {
			await this.violationService.recordViolation({
				id: uuid(),
				type: ViolationType.BLOCKED_IP,
				ip: event.ipAddress,
				points: ipStatus.points,
				details: {
					reason: 'IP bloqueada',
					originalViolation: event.violationType,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			throw new BadRequestException('La dirección IP está bloqueada');
		}

		// Validar puntos y nivel de riesgo
		if (typeof event.points !== 'number' || event.points < 0) {
			throw new BadRequestException('Los puntos deben ser un número positivo');
		}
	}

	private validateBusinessEvent(event: BusinessEvent): void {
		if (!event.type) {
			throw new BadRequestException('El campo type es requerido para eventos de negocio');
		}
		if (!event.entityId) {
			throw new BadRequestException('El campo entityId es requerido para eventos de negocio');
		}
		if (!event.entityType) {
			throw new BadRequestException('El campo entityType es requerido para eventos de negocio');
		}
		if (!event.category) {
			throw new BadRequestException('El campo category es requerido para eventos de negocio');
		}
		if (!event.action) {
			throw new BadRequestException('El campo action es requerido para eventos de negocio');
		}
	}

	private validateAuthEvent(event: AuditEvent): void {
		if (event.type !== EventType.AUDIT) {
			throw new BadRequestException('El evento debe ser de tipo AUDIT');
		}

		if (!event.action) {
			throw new BadRequestException('El campo action es requerido para eventos de auditoría');
		}

		if (!event.resourceId) {
			throw new BadRequestException('El campo resourceId es requerido para eventos de auditoría');
		}

		if (!event.resourceType) {
			throw new BadRequestException('El campo resourceType es requerido para eventos de auditoría');
		}

		if (!event.correlationId || !this.isValidGuid(event.correlationId)) {
			throw new BadRequestException('El campo correlationId es requerido y debe ser un GUID válido');
		}

		if (!event.timestamp || !(event.timestamp instanceof Date)) {
			throw new BadRequestException('El campo timestamp es requerido y debe ser una fecha válida');
		}

		// Validar que el provider sea MSAL si está presente en metadata
		if (event.metadata?.provider && event.metadata.provider !== 'msal') {
			throw new BadRequestException('El provider debe ser "msal"');
		}

		// Validar que el tenantId sea un GUID válido si está presente en metadata
		if (event.metadata?.tenantId && !this.isValidGuid(event.metadata.tenantId)) {
			throw new BadRequestException('El tenantId debe ser un GUID válido');
		}
	}

	private isValidGuid(str: string): boolean {
		const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		return guidRegex.test(str);
	}

	private enrichEventData<T extends BaseEvent>(event: Partial<T> & Pick<BaseEvent, 'type'>, req?: Request): T {
		// Primero creamos un objeto que cumpla con BaseEvent
		const baseEvent: BaseEvent = {
			id: uuid(), // Requerido por Identifiable
			type: event.type, // Requerido por Pick<BaseEvent, 'type'>
			timestamp: event.timestamp || new Date(),
			correlationId: event.correlationId || uuid(),
			severity: event.severity || EventSeverity.INFO,
			status: event.status || EventStatus.COMPLETED, // Estado por defecto
			userId: event.userId,
			metadata: {
				...event.metadata,
				eventId: uuid(), // Siempre generamos un nuevo UUID para el evento
			},
		};

		// Enriquecer con información del usuario si hay request
		if (req) {
			const userInfo = UserUtils.extractUserInfo(req);
			baseEvent.userId = event.userId || userInfo.userId;
			baseEvent.metadata = {
				...baseEvent.metadata,
				userInfo,
			};
		}

		// Combinar el evento base con los campos específicos del tipo T
		const enrichedEvent = {
			...baseEvent,
			...event,
			metadata: baseEvent.metadata, // Aseguramos que metadata no se sobrescriba
		} as unknown as T;

		return enrichedEvent;
	}

	async logSecurityEvent(event: Partial<SecurityEvent>, req?: Request): Promise<SecurityEvent> {
		const securityEvent: SecurityEvent = {
			...event,
			type: EventType.SECURITY,
			points: event.points || 0,
			violationType: event.violationType!,
			ipAddress: event.ipAddress,
		} as SecurityEvent;

		await this.validateSecurityEvent(securityEvent);
		const enrichedEvent = this.enrichEventData<SecurityEvent>(securityEvent, req);

		// Log del evento
		await this.logger.log(`Security Event: ${enrichedEvent.violationType}`, enrichedEvent.userId, 'security', {
			...enrichedEvent,
			eventType: 'security',
		});

		// Telemetría
		const telemetryResult = await this.telemetry.trackSecurityEvent(enrichedEvent.userId || 'anonymous', {
			violationType: enrichedEvent.violationType,
			points: enrichedEvent.points,
			ipAddress: enrichedEvent.ipAddress || 'unknown',
			metadata: enrichedEvent.metadata,
		});

		if (!telemetryResult.success) {
			this.logger.warn('Error al registrar telemetría de seguridad', enrichedEvent.userId, 'telemetry', {
				error: telemetryResult.error,
				event: enrichedEvent,
			});
		}

		return enrichedEvent;
	}

	async logBusinessEvent(event: BusinessEvent, req?: Request): Promise<BusinessEvent> {
		this.validateBusinessEvent(event);
		const enrichedEvent = this.enrichEventData<BusinessEvent>(event, req);

		// Log del evento
		await this.logger.log(`Business Event: ${enrichedEvent.action}`, enrichedEvent.userId, 'business', {
			...enrichedEvent,
			eventType: 'business',
		});

		// Telemetría
		const telemetryResult = await this.telemetry.trackDocumentEvent(enrichedEvent.userId || 'anonymous', EventNames.Document.Process.Complete, {
			documentId: enrichedEvent.entityId,
			documentType: enrichedEvent.entityType,
			operation: enrichedEvent.action,
			result: 'success',
		});

		if (!telemetryResult.success) {
			this.logger.warn('Error al registrar telemetría de negocio', enrichedEvent.userId, 'telemetry', {
				error: telemetryResult.error,
				event: enrichedEvent,
			});
		}

		return enrichedEvent;
	}

	async logDocumentEvent(event: BusinessEvent, req?: Request): Promise<BusinessEvent> {
		this.validateBusinessEvent(event);
		const enrichedEvent = this.enrichEventData<BusinessEvent>(event, req);

		// Log del evento
		await this.logger.log(`Document ${enrichedEvent.action}: ${enrichedEvent.entityId}`, enrichedEvent.userId, 'document', {
			type: enrichedEvent.type,
			documentId: enrichedEvent.entityId,
			documentType: enrichedEvent.entityType,
			operation: enrichedEvent.action,
			size: enrichedEvent.metadata?.size,
			duration: enrichedEvent.metadata?.duration,
			metadata: enrichedEvent.metadata,
		});

		// Telemetría
		const telemetryResult = await this.telemetry.trackDocumentEvent(enrichedEvent.userId || 'anonymous', EventNames.Document.Process.Complete, {
			documentId: enrichedEvent.entityId,
			documentType: enrichedEvent.entityType,
			operation: enrichedEvent.action,
			size: enrichedEvent.metadata?.size,
			duration: enrichedEvent.metadata?.duration,
			result: enrichedEvent.metadata?.status === 'failure' ? 'failure' : 'success',
			errorDetails: enrichedEvent.metadata?.status === 'failure' ? { error: enrichedEvent.metadata?.error } : undefined,
		});

		if (!telemetryResult.success) {
			this.logger.warn('Error al registrar telemetría de documento', enrichedEvent.userId, 'telemetry', {
				error: telemetryResult.error,
				event: enrichedEvent,
			});
		}

		return enrichedEvent;
	}

	async logAuthEvent(event: AuditEvent, req?: Request): Promise<AuditEvent> {
		this.validateAuthEvent(event);
		const enrichedEvent = this.enrichEventData<AuditEvent>(event, req);

		// Log del evento
		await this.logger.log(`Auth Event: ${enrichedEvent.action}`, enrichedEvent.userId, 'auth', {
			...enrichedEvent,
			eventType: 'auth',
		});

		// Telemetría
		const telemetryResult = await this.telemetry.trackAuthEvent(
			enrichedEvent.userId || 'anonymous',
			enrichedEvent.action === AuditAction.LOGIN
				? EventNames.Auth.Login.Success
				: enrichedEvent.action === AuditAction.LOGOUT
					? EventNames.Auth.Logout.Success
					: EventNames.Auth.DeviceChange,
			{
				provider: 'msal',
				tenantId: enrichedEvent.metadata?.tenantId || 'unknown',
				result: enrichedEvent.metadata?.status || 'success',
				errorCode: enrichedEvent.metadata?.error?.code,
				errorMessage: enrichedEvent.metadata?.error?.message,
				deviceInfo: enrichedEvent.metadata?.deviceInfo,
			}
		);

		if (!telemetryResult.success) {
			this.logger.warn('Error al registrar telemetría de autenticación', enrichedEvent.userId, 'telemetry', {
				error: telemetryResult.error,
				event: enrichedEvent,
			});
		}

		return enrichedEvent;
	}

	async logClientError(event: BaseEvent): Promise<void> {
		try {
			// 1. Registrar en MongoDB a través del logger
			await this.logger.logErrorWithMetadata(new Error(event.metadata.error.message), {
				userId: event.userId,
				correlationId: event.correlationId,
				metadata: event.metadata,
			});

			// 2. Registrar en telemetría (sin Application Insights)
			const clientError = new Error(event.metadata.error.message);
			if (event.metadata.error.stack) {
				clientError.stack = event.metadata.error.stack;
			}

			await this.telemetry.trackException(clientError, event.userId || 'anonymous', {
				correlationId: event.correlationId,
				severity: event.severity,
				componentName: event.metadata.componentName,
				url: event.metadata.url,
				...event.metadata.browserInfo,
			});
		} catch (error) {
			// Si falla el logging, al menos intentamos registrar el error
			this.logger.error(`Error al procesar error del cliente: ${error.message}`, event.userId, error.stack, 'EventsService.logClientError');
			throw error;
		}
	}
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';

import { AppLoggerService } from '@/logger/app-logger.service';
import { TelemetryService } from '@/telemetry/telemetry.service';

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
	constructor(
		private readonly logger: AppLoggerService,
		private readonly telemetry: TelemetryService
	) {}

	catch(exception: any, host: ArgumentsHost) {
		const ctx = host.switchToHttp();
		const response = ctx.getResponse<Response>();
		const request = ctx.getRequest<Request>();
		const timestamp = new Date();

		// Extraer información del usuario
		const user = request.user as any;
		const userId = user?.extension_oid || 'anonymous';
		const correlationId = request.headers['x-correlation-id'] || uuid();

		// Determinar el tipo de error y código HTTP
		const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

		// Registrar error usando el método error del logger
		this.logger.error(exception.message || 'Error interno del servidor', userId, exception.stack, 'GlobalExceptionFilter');

		// Registrar excepción con más contexto (sin Application Insights)
		if (this.telemetry) {
			this.telemetry.trackException(exception, userId, {
				correlationId,
				path: request.url,
				method: request.method,
				statusCode: status,
				timestamp: timestamp.toISOString(),
			});
		}

		// Respuesta consistente
		response.status(status).json({
			success: false,
			error: {
				message: this.getClientMessage(exception),
				code: exception.code || 'INTERNAL_ERROR',
				correlationId,
				timestamp: timestamp.toISOString(),
				details:
					process.env.NODE_ENV === 'development'
						? {
								path: request.url,
								method: request.method,
								userId,
								stack: exception.stack,
							}
						: undefined,
			},
		});
	}

	private getClientMessage(exception: any): string {
		// Si es un error HTTP de NestJS, usar su mensaje
		if (exception instanceof HttpException) {
			return exception.message;
		}

		// En producción, no exponer detalles internos
		if (process.env.NODE_ENV === 'production') {
			return 'Ha ocurrido un error interno. Por favor, contacte al soporte técnico.';
		}

		// En desarrollo, mostrar el mensaje real
		return exception.message || 'Error interno del servidor';
	}
}

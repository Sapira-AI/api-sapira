import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import pino from 'pino';
import { v4 as uuid } from 'uuid';

import { BaseResponse } from '@/core/interfaces/base/base.interface';
import { ErrorSeverity } from '@/core/interfaces/base/error-codes.interface';
import { ErrorContext } from '@/core/interfaces/error.types';
import { BaseLogProperties } from '@/core/interfaces/log/log.interface';
import { SecurityViolationType } from '@/core/interfaces/security/security.types';
import { BaseService } from '@/core/services/base/base.service';
import { EventNames } from '@/telemetry/constants/event-names';
import { TelemetryService } from '@/telemetry/telemetry.service';

@Injectable()
export class AppLoggerService extends BaseService implements OnModuleInit {
	private pinoLogger: pino.Logger;
	protected override readonly logger: Logger;

	constructor(
		@Inject('LogModelToken')
		private readonly logModel: Model<any>,
		private readonly configService: ConfigService,
		@Optional() private readonly telemetry?: TelemetryService
	) {
		super();
		this.logger = new Logger(this.constructor.name);
	}

	async onModuleInit() {
		try {
			const logLevel = this.configService.get('app.logLevel', 'info');

			this.pinoLogger = pino(
				{
					level: logLevel,
					timestamp: true,
					formatters: {
						level: (label) => ({ level: label }),
					},
				},
				{
					write: async (obj) => {
						try {
							const logData = JSON.parse(obj);
							const now = new Date();
							await this.logModel.create({
								level: logData.level,
								time: new Date(logData.time),
								message: logData.msg,
								type: logData.type,
								correlationId: logData.correlationId,
								userId: logData.userId,
								metadata: logData.additional,
								trace: logData.trace,
								createdAt: now,
								updatedAt: now,
								expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
							});
						} catch (error) {
							console.error('Error al guardar log en MongoDB:', error);
						}
					},
				}
			);
		} catch (error) {
			return this.handleError(error, {
				context: 'AppLoggerService.onModuleInit',
				severity: ErrorSeverity.CRITICAL,
			});
		}
	}

	private getBaseProperties(message: string, userId?: string): BaseLogProperties {
		return {
			msg: message,
			time: new Date(),
			correlationId: uuid(),
			userId,
		};
	}

	log(message: string, userId?: string, context?: string, metadata?: any) {
		const baseProps = this.getBaseProperties(message, userId);
		this.pinoLogger.info({
			...baseProps,
			type: 'general',
			additional: { context, ...metadata },
		});
		this.logger.log(message);
	}

	error(message: string, userId?: string, trace?: string, context?: string) {
		const baseProps = this.getBaseProperties(message, userId);
		this.pinoLogger.error({
			...baseProps,
			type: 'error',
			level: 'error',
			trace,
			additional: { context },
		});
		this.logger.error(message);
	}

	warn(message: string, userId?: string, context?: string, metadata?: any) {
		const baseProps = this.getBaseProperties(message, userId);
		this.pinoLogger.warn({
			...baseProps,
			type: 'warning',
			level: 'warn',
			additional: { context, ...metadata },
		});
		this.logger.warn(message);
	}

	logError(errorContext: ErrorContext) {
		const { message, code, stack, metadata, level = 'error', source } = errorContext;
		const baseProps = this.getBaseProperties(message);
		this.pinoLogger[level]({
			...baseProps,
			type: 'error',
			error_code: code,
			stack,
			additional: { ...metadata, source },
		});
		this.logger.error(message);
	}

	logApi(req: any, res: any, responseTime: number) {
		const userId = req.user?.extension_oid;
		const baseProps = this.getBaseProperties(`API ${req.method} ${req.url}`, userId);
		this.pinoLogger.info({
			...baseProps,
			type: 'api',
			additional: {
				method: req.method,
				url: req.url,
				statusCode: res.statusCode,
				responseTime,
				userAgent: req.headers['user-agent'],
				ip: req.ip,
			},
		});
		this.logger.log(`API ${req.method} ${req.url}`);

		if (this.telemetry) {
			this.telemetry.trackApiCall(userId || 'anonymous', {
				endpoint: req.url,
				method: req.method,
				duration: responseTime,
				statusCode: res.statusCode,
				errorMessage: res.statusCode >= 400 ? res.statusMessage : undefined,
			});
		}
	}

	logDocument(userId: string, documentId: string, operation: string, status: 'success' | 'failure', details?: any) {
		const baseProps = this.getBaseProperties(`Document ${operation}: ${documentId}`, userId);
		this.pinoLogger.info({
			...baseProps,
			type: 'document',
			additional: {
				documentId,
				operation,
				status,
				size: details?.size,
				duration: details?.duration,
				errorDetails: details?.error,
			},
		});
		this.logger.log(`Document ${operation}: ${documentId}`);
	}

	logSecurityViolation(
		ip: string,
		violation: {
			type: string;
			points: number;
			details: any;
		},
		userId?: string
	) {
		const baseProps = this.getBaseProperties(`Security Violation: ${violation.type}`, userId);
		this.pinoLogger.warn({
			...baseProps,
			type: 'security',
			additional: {
				violationType: violation.type,
				ipAddress: ip,
				points: violation.points,
				riskLevel: violation.points > 50 ? 'high' : 'medium',
				metadata: violation.details,
			},
		});
		this.logger.warn(`Security Violation: ${violation.type}`);
		if (this.telemetry) {
			this.telemetry.trackSecurityEvent(userId || 'anonymous', {
				violationType: violation.type,
				points: violation.points,
				ipAddress: ip,
				...violation.details,
			});
		}
	}

	logAuthAttempt(
		userId: string,
		details: {
			provider: string;
			deviceInfo?: {
				browser: string;
				os: string;
				version?: string;
				userAgent?: string;
			};
			result?: string;
		},
		metadata?: Record<string, any>
	) {
		const baseProps = this.getBaseProperties(`Auth attempt by user: ${userId}`, userId);
		this.pinoLogger.info({
			...baseProps,
			type: 'auth',
			additional: {
				provider: details.provider,
				deviceInfo: details.deviceInfo,
				result: details.result || 'success',
				...metadata,
			},
		});
		this.logger.log(`Auth attempt by user: ${userId}`);
	}

	async queryLogs(filter: any = {}, options: any = {}) {
		const defaultOptions = {
			sort: { time: -1 },
			limit: 100,
		};

		return this.logModel.find(filter, null, { ...defaultOptions, ...options });
	}

	async getDocumentHistory(documentId: string, timeWindow: number = 7 * 24 * 60 * 60 * 1000) {
		const since = new Date(Date.now() - timeWindow);
		return this.queryLogs({
			type: 'document',
			'metadata.documentId': documentId,
			time: { $gte: since },
		});
	}

	async getUserActivityHistory(userId: string, timeWindow: number = 24 * 60 * 60 * 1000) {
		const since = new Date(Date.now() - timeWindow);
		return this.queryLogs({
			userId,
			time: { $gte: since },
		});
	}

	async getErrorsByUser(userId: string, timeWindow: number = 24 * 60 * 60 * 1000) {
		const since = new Date(Date.now() - timeWindow);
		return this.queryLogs({
			userId,
			level: 'error',
			time: { $gte: since },
		});
	}

	async getDocumentErrors(timeWindow: number = 24 * 60 * 60 * 1000) {
		const since = new Date(Date.now() - timeWindow);
		return this.queryLogs({
			type: 'document',
			'metadata.status': 'failure',
			time: { $gte: since },
		});
	}

	async getIpPoints(
		ip: string,
		timeWindow: number = 24 * 60 * 60 * 1000
	): Promise<{
		totalPoints: number;
		violations: Array<{
			type: string;
			points: number;
			timestamp: Date;
			details?: any;
		}>;
	}> {
		const since = new Date(Date.now() - timeWindow);

		// Buscar todas las violaciones de seguridad para esta IP
		const violations = await this.logModel
			.find(
				{
					type: 'security',
					'metadata.ipAddress': ip,
					time: { $gte: since },
				},
				{
					'metadata.violationType': 1,
					'metadata.points': 1,
					time: 1,
					'metadata.details': 1,
				}
			)
			.sort({ time: -1 });

		// Mapear las violaciones al formato requerido
		const mappedViolations = violations.map((v) => ({
			type: v.metadata?.violationType,
			points: v.metadata?.points || 0,
			timestamp: v.time,
			details: v.metadata?.details,
		}));

		// Calcular puntos totales
		const totalPoints = mappedViolations.reduce((sum, violation) => sum + violation.points, 0);

		return {
			totalPoints,
			violations: mappedViolations,
		};
	}

	async shouldBlockIp(ip: string, threshold: number): Promise<boolean> {
		const timeWindow = 24 * 60 * 60 * 1000; // 24 horas
		const since = new Date(Date.now() - timeWindow);

		// Buscar todas las violaciones de seguridad para esta IP en las últimas 24 horas
		const violations = await this.logModel.find({
			type: 'security',
			'metadata.ipAddress': ip,
			time: { $gte: since },
		});

		// Sumar los puntos de todas las violaciones
		const totalPoints = violations.reduce((sum, violation) => {
			return sum + (violation.metadata?.points || 0);
		}, 0);

		// Registrar para monitoreo
		if (totalPoints > 0) {
			this.warn(`IP ${ip} ha acumulado ${totalPoints} puntos en las últimas 24 horas`, undefined, 'ip-filter', {
				threshold,
				violations: violations.length,
			});
		}

		return totalPoints >= threshold;
	}

	async getIpViolationHistory(
		ip: string,
		options: {
			timeWindow?: number;
			limit?: number;
			skip?: number;
			sort?: 'asc' | 'desc';
		} = {}
	): Promise<{
		total: number;
		history: Array<{
			type: string;
			points: number;
			timestamp: Date;
			details?: any;
			userAgent?: string;
			userId?: string;
		}>;
		summary: {
			totalPoints: number;
			violationsByType: Record<string, number>;
			lastViolation?: Date;
			firstViolation?: Date;
		};
	}> {
		const {
			timeWindow = 7 * 24 * 60 * 60 * 1000, // 7 días por defecto
			limit = 50,
			skip = 0,
			sort = 'desc',
		} = options;

		const since = new Date(Date.now() - timeWindow);

		// Buscar todas las violaciones
		const violations = await this.logModel
			.find(
				{
					type: 'security',
					'metadata.ipAddress': ip,
					time: { $gte: since },
				},
				{
					'metadata.violationType': 1,
					'metadata.points': 1,
					time: 1,
					'metadata.details': 1,
					userAgent: 1,
					userId: 1,
				}
			)
			.sort({ time: sort === 'desc' ? -1 : 1 })
			.skip(skip)
			.limit(limit);

		// Contar total de violaciones para paginación
		const total = await this.logModel.countDocuments({
			type: 'security',
			'metadata.ipAddress': ip,
			time: { $gte: since },
		});

		// Mapear las violaciones
		const mappedViolations = violations.map((v) => ({
			type: v.metadata?.violationType,
			points: v.metadata?.points || 0,
			timestamp: v.time,
			details: v.metadata?.details,
			userAgent: v.userAgent,
			userId: v.userId,
		}));

		// Calcular estadísticas
		const summary = {
			totalPoints: 0,
			violationsByType: {} as Record<string, number>,
			lastViolation: mappedViolations[0]?.timestamp,
			firstViolation: mappedViolations[mappedViolations.length - 1]?.timestamp,
		};

		mappedViolations.forEach((violation) => {
			summary.totalPoints += violation.points;
			if (violation.type) {
				summary.violationsByType[violation.type] = (summary.violationsByType[violation.type] || 0) + 1;
			}
		});

		return {
			total,
			history: mappedViolations,
			summary,
		};
	}

	async getSecurityViolations(ip: string): Promise<{ points: number }[]> {
		try {
			const violations = await this.logModel
				.find({
					type: 'security',
					'metadata.ip': ip,
					'metadata.type': { $in: ['blocked_ip', 'unauthorized_access', 'suspicious_activity'] },
					time: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Últimas 24 horas
				})
				.select('metadata.points')
				.lean();

			return violations.map((v) => ({ points: v.metadata?.points || 0 }));
		} catch (error) {
			this.error(`Error getting security violations for IP ${ip}`, error);
			return [];
		}
	}

	async logDocumentEvent(properties: {
		userId: string;
		documentId: string;
		operation: string;
		status: 'success' | 'failure';
		error?: Error;
		metadata?: Record<string, unknown>;
	}): Promise<BaseResponse<void>> {
		try {
			const logData = {
				type: 'document',
				correlationId: uuid(),
				userId: properties.userId,
				documentId: properties.documentId,
				operation: properties.operation,
				status: properties.status,
				error: properties.error
					? {
							name: properties.error.name,
							message: properties.error.message,
							stack: properties.error.stack,
						}
					: undefined,
				metadata: properties.metadata,
				time: new Date(),
			};

			await this.logModel.create(logData);

			// También registrar en telemetría si está disponible
			if (this.telemetry) {
				await this.telemetry.trackDocumentEvent(properties.userId, EventNames.Document.Process.Complete, {
					documentId: properties.documentId,
					documentType: 'default',
					operation: properties.operation,
					result: properties.status,
					errorDetails: properties.error
						? {
								name: properties.error.name,
								message: properties.error.message,
							}
						: undefined,
					...properties.metadata,
				});
			}

			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'AppLoggerService.logDocumentEvent',
				metadata: { properties },
			});
		}
	}

	async logErrorWithMetadata(
		error: Error,
		properties?: {
			userId?: string;
			correlationId?: string;
			metadata?: Record<string, unknown>;
		}
	): Promise<BaseResponse<void>> {
		try {
			const logData = {
				type: 'error',
				correlationId: properties?.correlationId || uuid(),
				userId: properties?.userId || 'system',
				error: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
				metadata: properties?.metadata,
				time: new Date(),
			};

			await this.logModel.create(logData);

			// También registrar en telemetría si está disponible
			if (this.telemetry) {
				await this.telemetry.trackException(error, properties?.userId || 'system', {
					correlationId: logData.correlationId,
					...properties?.metadata,
				});
			}

			return this.createSuccessResponse<void>(undefined);
		} catch (loggingError) {
			return this.handleError(loggingError, {
				context: 'AppLoggerService.logErrorWithMetadata',
				metadata: {
					originalError: {
						name: error.name,
						message: error.message,
					},
					properties,
				},
			});
		}
	}

	async logSecurityEvent(
		violation: SecurityViolationType,
		properties: {
			userId?: string;
			metadata?: Record<string, unknown>;
		}
	): Promise<BaseResponse<void>> {
		try {
			const logData = {
				type: 'security',
				correlationId: uuid(),
				userId: properties.userId || 'system',
				violation,
				metadata: properties.metadata,
				time: new Date(),
			};

			await this.logModel.create(logData);

			// También registrar en telemetría si está disponible
			if (this.telemetry) {
				const telemetryResult = await this.telemetry.trackSecurityEvent(properties.userId || 'system', {
					violation,
					...properties.metadata,
				});

				if (!telemetryResult.success && telemetryResult.error) {
					await this.logErrorWithMetadata(new Error('Error al registrar telemetría de seguridad'), {
						userId: properties.userId,
						correlationId: logData.correlationId,
						metadata: {
							telemetryError: telemetryResult.error,
						},
					});
				}
			}

			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'AppLoggerService.logSecurityEvent',
				metadata: { violation, properties },
			});
		}
	}
}

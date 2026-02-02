import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	Header,
	InternalServerErrorException,
	Ip,
	Param,
	Post,
	Query,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';

import { AzureADAuthGuard } from '@/auth/strategies/azuread-auth.guard';
import { EventSeverity, EventStatus, EventType, SecurityAction, SecurityEvent, SecurityOutcome } from '@/core/interfaces/events/event.interface';
import { SecurityViolationType } from '@/core/interfaces/security/security.types';
import { SecurityUtils } from '@/core/utils/security.utils';
import { EventsService } from '@/events/services/events.service';
import { AppLoggerService } from '@/logger/app-logger.service';
import { UserResponseDto } from '@/modules/users/dtos/users.dto';
import { DeviceInfo, UserUtils } from '@/security/utils/user.utils';

import { RISK_THRESHOLDS } from './constants/security.constants';
import { SimulateViolationDto } from './dto/simulate-violation.dto';
import { SecurityService } from './services/security.service';

// @ApiExcludeController()
@ApiTags('Security')
@Controller('security')
@UseGuards(AzureADAuthGuard)
@ApiBearerAuth()
export class SecurityController {
	constructor(
		private readonly logger: AppLoggerService,
		private readonly securityService: SecurityService,
		private readonly events: EventsService
	) {}

	@Get('points')
	@ApiOperation({ summary: 'Consulta los puntos de seguridad acumulados por una IP' })
	@ApiResponse({ status: 200, description: 'Puntos consultados correctamente' })
	async checkIpPoints(@Query('ip') ip: string, @Req() req: Request & { user?: UserResponseDto }) {
		// Validar IP
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		if (!ipValidation.ip) {
			throw new BadRequestException('Dirección IP inválida');
		}

		// Validar usuario
		const userId = this.normalizeUserId(req);
		if (!UserUtils.isValidUserId(userId)) {
			throw new BadRequestException('Usuario inválido');
		}

		const pointsData = await this.logger.getIpPoints(ipValidation.ip);
		await this.logger.getIpViolationHistory(ipValidation.ip);

		// Validar y normalizar puntos
		const { normalizedPoints } = SecurityUtils.validatePoints(pointsData.totalPoints);
		const shouldBlock = await this.logger.shouldBlockIp(ipValidation.ip, RISK_THRESHOLDS.HIGH);
		const riskLevel = this.calculateRiskLevel(normalizedPoints);

		// Construir evento de seguridad
		const securityEvent: SecurityEvent = {
			id: uuid(),
			type: EventType.SECURITY,
			violationType: shouldBlock ? SecurityViolationType.POINTS_THRESHOLD_EXCEEDED : SecurityViolationType.SUSPICIOUS_ACTIVITY,
			ipAddress: ipValidation.ip,
			userId,
			severity: this.mapRiskLevelToEventSeverity(riskLevel),
			points: normalizedPoints,
			timestamp: new Date(),
			correlationId: uuid(),
			status: EventStatus.COMPLETED,
			action: shouldBlock ? SecurityAction.IP_BLOCKED : SecurityAction.SUSPICIOUS_ACTIVITY,
			outcome: shouldBlock ? SecurityOutcome.BLOCKED : SecurityOutcome.WARNING,
			metadata: {
				action: shouldBlock ? 'IP Blocked' : 'Warning',
				deviceInfo: UserUtils.extractDeviceInfo(req),
			},
		};

		await this.events.logSecurityEvent(securityEvent);

		return {
			ip: ipValidation.ip,
			points: normalizedPoints,
			riskLevel,
			shouldBlock,
			deviceInfo: UserUtils.extractDeviceInfo(req),
		};
	}

	@Get('check-ip')
	@UseGuards(ThrottlerGuard)
	@ApiOperation({ summary: 'Verifica los puntos de una IP' })
	@ApiQuery({ name: 'ip', description: 'IP a verificar' })
	async checkIp(
		@Query('ip') ip: string,
		@Req() req: Request & { user?: UserResponseDto }
	): Promise<{
		ip: string;
		points: number;
		riskLevel: string;
		shouldBlock: boolean;
		deviceInfo: DeviceInfo;
	}> {
		// Validar y normalizar IP
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});

		// Validar usuario
		const userId = this.normalizeUserId(req);
		if (!UserUtils.isValidUserId(userId)) {
			throw new BadRequestException('Usuario inválido');
		}

		// Obtener puntos y violaciones
		const pointsData = await this.logger.getIpPoints(ipValidation.ip);
		await this.logger.getIpViolationHistory(ipValidation.ip);

		// Validar y normalizar puntos
		const { normalizedPoints } = SecurityUtils.validatePoints(pointsData.totalPoints);
		const shouldBlock = await this.logger.shouldBlockIp(ipValidation.ip, RISK_THRESHOLDS.HIGH);
		const riskLevel = this.calculateRiskLevel(normalizedPoints);

		// Construir evento de seguridad
		const securityEvent: SecurityEvent = {
			id: uuid(),
			type: EventType.SECURITY,
			violationType: shouldBlock ? SecurityViolationType.POINTS_THRESHOLD_EXCEEDED : SecurityViolationType.SUSPICIOUS_ACTIVITY,
			ipAddress: ipValidation.ip,
			userId,
			severity: this.mapRiskLevelToEventSeverity(riskLevel),
			points: normalizedPoints,
			timestamp: new Date(),
			correlationId: uuid(),
			status: EventStatus.COMPLETED,
			action: shouldBlock ? SecurityAction.IP_BLOCKED : SecurityAction.SUSPICIOUS_ACTIVITY,
			outcome: shouldBlock ? SecurityOutcome.BLOCKED : SecurityOutcome.WARNING,
			metadata: {
				action: shouldBlock ? 'IP Blocked' : 'Warning',
				deviceInfo: UserUtils.extractDeviceInfo(req),
			},
		};

		await this.events.logSecurityEvent(securityEvent);

		return {
			ip: ipValidation.ip,
			points: normalizedPoints,
			riskLevel,
			shouldBlock,
			deviceInfo: UserUtils.extractDeviceInfo(req),
		};
	}

	@Get('check-ip-new')
	@UseGuards(ThrottlerGuard)
	@ApiOperation({ summary: 'Verifica los puntos de una IP' })
	@ApiQuery({ name: 'ip', description: 'IP a verificar' })
	async checkIpPointsNew(
		@Query('ip') ip: string,
		@Req() req: Request & { user?: UserResponseDto }
	): Promise<{
		ip: string;
		points: number;
		riskLevel: string;
		shouldBlock: boolean;
		deviceInfo: DeviceInfo;
	}> {
		// Validar y normalizar IP
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});

		// Validar usuario
		const userId = this.normalizeUserId(req);
		if (!UserUtils.isValidUserId(userId)) {
			throw new BadRequestException('Usuario inválido');
		}

		// Obtener puntos y violaciones
		const pointsData = await this.logger.getIpPoints(ipValidation.ip);
		await this.logger.getIpViolationHistory(ipValidation.ip);

		// Validar y normalizar puntos
		const { normalizedPoints } = SecurityUtils.validatePoints(pointsData.totalPoints);
		const shouldBlock = await this.logger.shouldBlockIp(ipValidation.ip, RISK_THRESHOLDS.HIGH);
		const riskLevel = this.calculateRiskLevel(normalizedPoints);
		const deviceInfo = UserUtils.extractDeviceInfo(req);

		// Construir evento de seguridad
		const securityEvent: SecurityEvent = {
			id: uuid(),
			type: EventType.SECURITY,
			violationType: shouldBlock ? SecurityViolationType.POINTS_THRESHOLD_EXCEEDED : SecurityViolationType.SUSPICIOUS_ACTIVITY,
			ipAddress: ipValidation.ip,
			userId,
			severity: this.mapRiskLevelToEventSeverity(riskLevel),
			points: normalizedPoints,
			timestamp: new Date(),
			correlationId: uuid(),
			status: EventStatus.COMPLETED,
			action: shouldBlock ? SecurityAction.IP_BLOCKED : SecurityAction.SUSPICIOUS_ACTIVITY,
			outcome: shouldBlock ? SecurityOutcome.BLOCKED : SecurityOutcome.WARNING,
			metadata: {
				action: shouldBlock ? 'IP Blocked' : 'Warning',
				deviceInfo,
			},
		};

		await this.events.logSecurityEvent(securityEvent);

		return {
			ip: ipValidation.ip,
			points: normalizedPoints,
			riskLevel,
			shouldBlock,
			deviceInfo,
		};
	}

	private normalizeUserId(req: Request & { user?: UserResponseDto }): string {
		return (req.user as any)?.extension_oid || req.user?.id || 'anonymous';
	}

	private calculateRiskLevel(points: number): 'HIGH' | 'MEDIUM' | 'LOW' {
		const { HIGH, MEDIUM } = RISK_THRESHOLDS;
		if (points >= HIGH) {
			return 'HIGH';
		} else if (points >= MEDIUM) {
			return 'MEDIUM';
		}
		return 'LOW';
	}

	private mapRiskLevelToEventSeverity(riskLevel: string): EventSeverity {
		switch (riskLevel.toUpperCase()) {
			case 'HIGH':
				return EventSeverity.CRITICAL;
			case 'MEDIUM':
				return EventSeverity.WARNING;
			case 'LOW':
				return EventSeverity.INFO;
			default:
				return EventSeverity.INFO;
		}
	}

	@Post('simulate-violation')
	@ApiOperation({
		summary: 'Simula una violación de seguridad',
		description:
			'Permite simular diferentes tipos de violaciones de seguridad para pruebas y validación del sistema de seguridad. El sistema registrará el evento y aplicará las políticas de seguridad correspondientes.',
	})
	@ApiBody({
		type: SimulateViolationDto,
		description: 'Datos para simular la violación de seguridad',
		examples: {
			'Actividad Sospechosa': {
				summary: 'Simular actividad sospechosa',
				value: {
					violationType: 'SUSPICIOUS_ACTIVITY',
					ipAddress: '192.168.1.1',
					description: 'Simulación de actividad sospechosa para pruebas',
					metadata: {
						test: true,
						reason: 'Testing violation simulation',
					},
				},
			},
			'Acceso No Autorizado': {
				summary: 'Simular acceso no autorizado',
				value: {
					violationType: 'UNAUTHORIZED_ACCESS',
					description: 'Intento de acceso no autorizado',
					metadata: {
						source: 'manual_test',
						severity: 'high',
					},
				},
			},
		},
	})
	@ApiResponse({
		status: 200,
		description: 'Violación simulada correctamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				data: {
					type: 'object',
					properties: {
						points: { type: 'number', example: 25 },
						riskLevel: { type: 'string', example: 'MEDIUM' },
						shouldBlock: { type: 'boolean', example: false },
					},
				},
			},
		},
	})
	@ApiResponse({ status: 400, description: 'Tipo de violación inválido o datos incorrectos' })
	@ApiResponse({ status: 500, description: 'Error interno del servidor' })
	async simulateViolation(@Body() input: SimulateViolationDto, @Req() req: Request & { user?: UserResponseDto }) {
		console.log('=== SIMULATE VIOLATION START ===');
		console.log('Input received:', JSON.stringify(input, null, 2));

		try {
			console.log('Step 1: Validating IP...');
			// Validar y normalizar IP
			const ipValidation = SecurityUtils.validateAndNormalizeIp(input.ipAddress || req.ip, {
				allowXForwardedFor: true,
				throwOnInvalid: true,
			});
			console.log('IP validation result:', ipValidation);

			console.log('Step 2: Validating violation type...');
			// Validar tipo de violación
			if (!SecurityUtils.isValidViolationType(input.violationType)) {
				throw new BadRequestException(`Invalid violation type: ${input.violationType}`);
			}
			console.log('Violation type is valid');

			console.log('Step 3: Getting violation points...');
			// Obtener puntos basados en el tipo de violación
			const points = SecurityUtils.getViolationPoints(input.violationType);
			console.log('Points:', points);

			console.log('Step 4: Validating points...');
			const { normalizedPoints } = SecurityUtils.validatePoints(points);
			console.log('Normalized points:', normalizedPoints);

			console.log('Step 5: Calculating risk level...');
			const riskLevel = this.calculateRiskLevel(normalizedPoints);
			console.log('Risk level:', riskLevel);

			// Crear y registrar el evento de seguridad
			const securityEvent: SecurityEvent = {
				id: uuid(),
				type: EventType.SECURITY,
				violationType: input.violationType,
				severity: this.mapRiskLevelToEventSeverity(riskLevel),
				points: normalizedPoints,
				timestamp: new Date(),
				correlationId: uuid(),
				ipAddress: ipValidation.ip,
				userId: this.normalizeUserId(req),
				status: EventStatus.COMPLETED,
				action: SecurityAction.SIMULATED_VIOLATION,
				outcome: SecurityOutcome.WARNING,
				metadata: {
					points: normalizedPoints,
					riskLevel,
					threshold: RISK_THRESHOLDS.HIGH,
					action: 'Simulated Violation',
					deviceInfo: UserUtils.extractDeviceInfo(req),
				},
			} as SecurityEvent;

			console.log('Step 6: Logging first security event...');
			console.log('Security event:', JSON.stringify(securityEvent, null, 2));
			await this.events.logSecurityEvent(securityEvent, req);
			console.log('First security event logged successfully');

			console.log('Step 7: Logging second security event...');
			// Emitir evento de seguridad
			await this.events.logSecurityEvent(
				{
					id: uuid(),
					type: EventType.SECURITY,
					violationType: input.violationType,
					userId: this.normalizeUserId(req),
					ipAddress: ipValidation.ip,
					severity: EventSeverity.ERROR,
					timestamp: new Date(),
					correlationId: uuid(),
					status: EventStatus.COMPLETED,
					action: SecurityAction.SIMULATED_VIOLATION,
					outcome: SecurityOutcome.WARNING,
					points: normalizedPoints,
					metadata: {
						points: normalizedPoints,
						riskLevel,
						action: 'Violation Simulated',
						...input.metadata,
					},
				} as SecurityEvent,
				req
			);

			return {
				success: true,
				data: {
					points: normalizedPoints,
					riskLevel,
					shouldBlock: points >= RISK_THRESHOLDS.HIGH,
				},
			};
		} catch (error) {
			// Registrar el error
			const clientIp = req.ip || 'unknown';
			await this.logger.logErrorWithMetadata(error as Error, {
				userId: this.normalizeUserId(req),
				metadata: {
					violationType: input.violationType,
					description: input.description,
					ip: clientIp,
				},
			});

			throw new InternalServerErrorException('Error al procesar la violación de seguridad', {
				cause: error,
				description: 'Ocurrió un error al intentar procesar y registrar la violación de seguridad',
			});
		}
	}

	@Get('ip-test')
	testIp(@Ip() ip: string) {
		return {
			message: 'IP Test endpoint',
			yourIp: ip,
			timestamp: new Date().toISOString(),
		};
	}

	@Get('rate-limit-test')
	testRateLimit() {
		return {
			message: 'Rate limit test endpoint',
			timestamp: new Date().toISOString(),
		};
	}

	@Get('throttle-test')
	@UseGuards(ThrottlerGuard)
	testThrottle() {
		return {
			message: 'Throttle test endpoint',
			timestamp: new Date().toISOString(),
		};
	}

	// Test XSS Protection
	@Get('xss-test')
	testXSS(@Res() res: Response) {
		const maliciousContent = `
      <div>
        <h1>XSS Test</h1>
        <script>alert('XSS Attack!');</script>
      </div>
    `;
		return res.send(maliciousContent);
	}

	// Test Content Security Policy
	@Get('csp-test')
	testCSP(@Res() res: Response) {
		const content = `
      <script src="https://malicious-site.com/script.js"></script>
      <h1>CSP Test</h1>
    `;
		return res.send(content);
	}

	// Test Clickjacking Protection
	@Get('clickjacking-test')
	testClickjacking(@Res() res: Response) {
		const content = `
      <h1>Clickjacking Test</h1>
      <iframe src="https://example.com"></iframe>
    `;
		return res.send(content);
	}

	// Test MIME Sniffing Prevention
	@Get('mime-test')
	@Header('Content-Type', 'text/plain')
	testMIME(@Res() res: Response) {
		const content = '<script>alert("This should not execute!");</script>';
		return res.send(content);
	}

	// Test Headers Exposure
	@Get('headers-test')
	testHeaders(@Res() res: Response) {
		return res.send('Check response headers');
	}

	// Endpoints para gestión de listas
	@Post('whitelist')
	@ApiOperation({ summary: 'Agregar IP a la lista blanca' })
	async addToWhitelist(@Body() dto: { ip: string; reason?: string; expiresAt?: Date }) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(dto.ip, {
			throwOnInvalid: true,
		});
		return await this.securityService.addToList(ipValidation.ip, 'whitelist', dto.reason, dto.expiresAt);
	}

	@Post('blacklist')
	@ApiOperation({ summary: 'Agregar IP a la lista negra' })
	async addToBlacklist(@Body() dto: { ip: string; reason?: string; expiresAt?: Date }) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(dto.ip, {
			throwOnInvalid: true,
		});
		return await this.securityService.addToList(ipValidation.ip, 'blacklist', dto.reason, dto.expiresAt);
	}

	@Delete('whitelist/:ip')
	@ApiOperation({ summary: 'Remover IP de la lista blanca' })
	async removeFromWhitelist(@Param('ip') ip: string) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		return await this.securityService.removeFromList(ipValidation.ip, 'whitelist');
	}

	@Delete('blacklist/:ip')
	@ApiOperation({ summary: 'Remover IP de la lista negra' })
	async removeFromBlacklist(@Param('ip') ip: string) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		return await this.securityService.removeFromList(ipValidation.ip, 'blacklist');
	}

	@Get('whitelist')
	@ApiOperation({ summary: 'Obtener lista blanca' })
	async getWhitelist() {
		return await this.securityService.getList('whitelist');
	}

	@Get('blacklist')
	@ApiOperation({ summary: 'Obtener lista negra' })
	async getBlacklist() {
		return await this.securityService.getList('blacklist');
	}

	@Get('my-ip')
	async getMyIp(@Req() req: Request & { user?: UserResponseDto }) {
		const clientIp = (req as any).ip || (req as any).socket?.remoteAddress || req.headers['x-forwarded-for'];
		return { ip: clientIp };
	}

	@Delete('blacklist/:ip')
	async removeFromBlacklistManual(@Param('ip') ip: string) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		await this.securityService.removeFromList(ipValidation.ip, 'blacklist');
		return { message: `IP ${ipValidation.ip} removida de la lista negra` };
	}

	@Get('ip-status/:ip')
	async getIpStatus(@Param('ip') ip: string) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		const isBlacklisted = await this.securityService.isInList(ipValidation.ip, 'blacklist');
		const isWhitelisted = await this.securityService.isInList(ipValidation.ip, 'whitelist');
		return {
			ip: ipValidation.ip,
			isBlacklisted,
			isWhitelisted,
		};
	}

	@Post('whitelist/:ip')
	async addToWhitelistManual(@Param('ip') ip: string) {
		const ipValidation = SecurityUtils.validateAndNormalizeIp(ip, {
			throwOnInvalid: true,
		});
		await this.securityService.addToList(ipValidation.ip, 'whitelist', 'Added manually');
		return { message: `IP ${ipValidation.ip} agregada a la lista blanca` };
	}
}

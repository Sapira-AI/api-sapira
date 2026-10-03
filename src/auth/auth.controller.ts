import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { Public } from '@/decorators/public.decorator';

import { PasswordRecoveryService } from './accounts/password-recovery.service';
import { PasswordRecoveryDto } from './dto/password-recovery.dto';
import { VerifyRecaptchaDto } from './dto/verify-recaptcha.dto';
import { RecaptchaService } from './services/recaptcha.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
	constructor(
		private readonly recaptchaService: RecaptchaService,
		private readonly passwordRecovery: PasswordRecoveryService
	) {}

	@Post('password-recovery')
	@Public()
	@HttpCode(200)
	@Throttle({ short: { limit: 3, ttl: 60000 } })
	@ApiOperation({
		summary: 'Recuperar contraseña: manda el enlace con la marca (contrato Configuración §10.6). Siempre 200, no revela si el correo existe',
	})
	@ApiResponse({ status: 200, description: 'Mismo mensaje exista o no la cuenta' })
	@ApiResponse({ status: 429, description: 'Más de 10 por minuto desde la misma IP real (X-Forwarded-For)' })
	requestPasswordRecovery(@Body() dto: PasswordRecoveryDto) {
		return this.passwordRecovery.request(dto.email);
	}

	@Get('public-config')
	@Public()
	@Throttle({ short: { limit: 30, ttl: 60000 } })
	@ApiOperation({ summary: 'Obtener configuración pública de autenticación y reCAPTCHA' })
	@ApiResponse({ status: 200, description: 'Configuración pública de reCAPTCHA' })
	getPublicAuthConfig() {
		return this.recaptchaService.getPublicAuthConfig();
	}

	@Post('recaptcha/verify')
	@Public()
	@Throttle({ short: { limit: 10, ttl: 60000 } })
	@ApiOperation({ summary: 'Validar un token de reCAPTCHA Enterprise' })
	@ApiResponse({ status: 200, description: 'Captcha válido' })
	@ApiResponse({ status: 400, description: 'Captcha inválido o acción incorrecta' })
	@ApiResponse({ status: 429, description: 'Demasiadas solicitudes' })
	async verifyRecaptcha(@Body() dto: VerifyRecaptchaDto, @Req() request: Request) {
		await this.recaptchaService.verifyToken(dto.token, {
			expectedAction: dto.action,
			remoteIp: this.getIpAddress(request),
			userAgent: request.headers['user-agent'],
		});

		return { ok: true };
	}

	private getIpAddress(request: Request) {
		const forwarded = request.headers['x-forwarded-for'];
		const forwardedIp = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
		return forwardedIp || request.ip;
	}
}

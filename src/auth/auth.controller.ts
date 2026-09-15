import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { Public } from '@/decorators/public.decorator';

import { VerifyRecaptchaDto } from './dto/verify-recaptcha.dto';
import { RecaptchaService } from './services/recaptcha.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
	constructor(private readonly recaptchaService: RecaptchaService) {}

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

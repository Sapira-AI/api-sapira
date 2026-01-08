import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CheckStatusDto } from './dto/check-status.dto';
import { GetSenderConfigDto } from './dto/get-sender-config.dto';
import { SendTestEmailDto } from './dto/send-test-email.dto';
import { VerifyDomainDto } from './dto/verify-domain.dto';
import { EmailService } from './email.service';
import { EmailSenderConfig } from './interfaces/email-sender-config.interface';

@ApiTags('Email')
@Controller('email')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class EmailController {
	constructor(private readonly emailService: EmailService) {}

	@Get('sender-config')
	@ApiOperation({
		summary: 'Obtener configuración de email del holding',
		description: 'Retorna la configuración actual de email sender para el holding especificado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración obtenida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró configuración para este holding',
	})
	@HttpCode(HttpStatus.OK)
	async getSenderConfig(@Query() dto: GetSenderConfigDto): Promise<EmailSenderConfig | null> {
		return this.emailService.getSenderConfig(dto);
	}

	@Post('verify-domain')
	@ApiOperation({
		summary: 'Verificar y registrar dominio en Resend',
		description:
			'Crea un dominio en Resend API y guarda los DNS records que el cliente debe configurar. Retorna la configuración con los registros DNS necesarios.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Dominio registrado exitosamente. Configura los DNS records provistos.',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos inválidos o error en Resend API',
	})
	@HttpCode(HttpStatus.OK)
	async verifyDomain(@Body() dto: VerifyDomainDto, @Req() request: any): Promise<EmailSenderConfig> {
		const userId = request.user?.id || request.user?.sub;
		return this.emailService.verifyDomain(dto, userId);
	}

	@Post('check-status')
	@ApiOperation({
		summary: 'Verificar estado del dominio en Resend',
		description: 'Consulta el estado actual del dominio en Resend y actualiza la configuración local.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado verificado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró configuración para este holding',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'No hay dominio registrado en Resend',
	})
	@HttpCode(HttpStatus.OK)
	async checkStatus(@Body() dto: CheckStatusDto): Promise<{ status: string; config: EmailSenderConfig }> {
		return this.emailService.checkStatus(dto);
	}

	@Post('send-test')
	@ApiOperation({
		summary: 'Enviar email de prueba',
		description: 'Envía un email de prueba usando la configuración verificada del holding. El dominio debe estar verificado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Email de prueba enviado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró configuración para este holding',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'El dominio no está verificado',
	})
	@HttpCode(HttpStatus.OK)
	async sendTestEmail(@Body() dto: SendTestEmailDto): Promise<{ message: string; note?: string }> {
		return this.emailService.sendTestEmail(dto);
	}
}

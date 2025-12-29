import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CheckStatusDto } from './dtos/check-status.dto';
import { CreateSenderAddressDto } from './dtos/create-sender-address.dto';
import { DeleteDomainDto } from './dtos/delete-domain.dto';
import { DeleteSenderAddressDto } from './dtos/delete-sender-address.dto';
import { ListDomainsDto } from './dtos/list-domains.dto';
import { ListSenderAddressesDto } from './dtos/list-sender-addresses.dto';
import { SendTestEmailDto } from './dtos/send-test-email.dto';
import { UpdateDomainDto } from './dtos/update-domain.dto';
import { UpdateSenderAddressDto } from './dtos/update-sender-address.dto';
import { VerifyDomainDto } from './dtos/verify-domain.dto';
import { EmailsService } from './emails.service';
import { DomainWithSenders, EmailSenderAddress } from './interfaces/email-sender-config.interface';

@ApiTags('Emails')
@Controller('emails')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class EmailsController {
	constructor(private readonly emailsService: EmailsService) {}

	@Get('sender-configs')
	@ApiOperation({
		summary: 'Listar todas las configuraciones de dominios del holding',
		description: 'Retorna todas las configuraciones de dominios con sus remitentes para el holding especificado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuraciones obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listDomains(@Query() dto: ListDomainsDto): Promise<DomainWithSenders[]> {
		return this.emailsService.listDomains(dto);
	}

	@Post('verify-domain')
	@ApiOperation({
		summary: 'Verificar y registrar dominio en SendGrid',
		description:
			'Crea un dominio en SendGrid API, guarda los DNS records y crea el primer remitente. Retorna la configuración con los registros DNS necesarios.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Dominio registrado exitosamente. Configura los DNS records provistos.',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos inválidos o error en SendGrid API',
	})
	@HttpCode(HttpStatus.OK)
	async verifyDomain(@Body() dto: VerifyDomainDto, @Req() request: any): Promise<DomainWithSenders> {
		const userId = request.user?.id || request.user?.sub;
		return this.emailsService.verifyDomain(dto, userId);
	}

	@Post('check-status')
	@ApiOperation({
		summary: 'Verificar estado del dominio por defecto en SendGrid',
		description: 'Consulta el estado actual del dominio por defecto en SendGrid y actualiza la configuración local.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado verificado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró configuración por defecto para este holding',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'No hay dominio registrado en SendGrid',
	})
	@HttpCode(HttpStatus.OK)
	async checkStatus(@Body() dto: CheckStatusDto): Promise<{ status: string; config: DomainWithSenders }> {
		return this.emailsService.checkStatus(dto);
	}

	@Post('send-test')
	@ApiOperation({
		summary: 'Enviar email de prueba',
		description: 'Envía un email de prueba usando el dominio y remitente por defecto del holding. El dominio debe estar verificado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Email de prueba enviado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró configuración por defecto para este holding',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'El dominio no está verificado',
	})
	@HttpCode(HttpStatus.OK)
	async sendTestEmail(@Body() dto: SendTestEmailDto): Promise<{ message: string; note?: string }> {
		return this.emailsService.sendTestEmail(dto);
	}

	@Post('senders')
	@ApiOperation({
		summary: 'Crear nuevo remitente para un dominio',
		description: 'Crea una nueva dirección de remitente asociada a un dominio verificado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Remitente creado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró el dominio especificado',
	})
	@HttpCode(HttpStatus.OK)
	async createSender(@Body() dto: CreateSenderAddressDto, @Req() request: any): Promise<EmailSenderAddress> {
		const userId = request.user?.id || request.user?.sub;
		return this.emailsService.createSenderAddress(dto, userId);
	}

	@Get('senders')
	@ApiOperation({
		summary: 'Listar remitentes de un dominio',
		description: 'Retorna todas las direcciones de remitente para un dominio específico.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Remitentes obtenidos exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listSenders(@Query() dto: ListSenderAddressesDto): Promise<EmailSenderAddress[]> {
		return this.emailsService.listSenderAddresses(dto);
	}

	@Post('domains/update')
	@ApiOperation({
		summary: 'Actualizar configuración de dominio',
		description: 'Actualiza los campos editables de un dominio (display_name, is_default, is_active).',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Dominio actualizado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró el dominio especificado',
	})
	@HttpCode(HttpStatus.OK)
	async updateDomain(@Body() dto: UpdateDomainDto & { domain_id: string }): Promise<DomainWithSenders> {
		const { domain_id, ...updateData } = dto;
		return this.emailsService.updateDomain(domain_id, updateData);
	}

	@Post('senders/update')
	@ApiOperation({
		summary: 'Actualizar remitente',
		description: 'Actualiza los campos editables de un remitente.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Remitente actualizado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró el remitente especificado',
	})
	@HttpCode(HttpStatus.OK)
	async updateSender(@Body() dto: UpdateSenderAddressDto & { sender_id: string }): Promise<EmailSenderAddress> {
		const { sender_id, ...updateData } = dto;
		return this.emailsService.updateSenderAddress(sender_id, updateData);
	}

	@Post('domains/delete')
	@ApiOperation({
		summary: 'Eliminar dominio',
		description: 'Elimina un dominio y todos sus remitentes asociados. También intenta eliminar el dominio de SendGrid.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Dominio eliminado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró el dominio especificado',
	})
	@HttpCode(HttpStatus.OK)
	async deleteDomain(@Body() dto: DeleteDomainDto): Promise<{ message: string }> {
		return this.emailsService.deleteDomain(dto);
	}

	@Post('senders/delete')
	@ApiOperation({
		summary: 'Eliminar remitente',
		description: 'Elimina una dirección de remitente.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Remitente eliminado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No se encontró el remitente especificado',
	})
	@HttpCode(HttpStatus.OK)
	async deleteSender(@Body() dto: DeleteSenderAddressDto): Promise<{ message: string }> {
		return this.emailsService.deleteSenderAddress(dto);
	}
}

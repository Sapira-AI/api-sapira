import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { CheckStatusDto } from './dto/check-status.dto';
import { GetSenderConfigDto } from './dto/get-sender-config.dto';
import { SendTestEmailDto } from './dto/send-test-email.dto';
import { VerifyDomainDto } from './dto/verify-domain.dto';
import { EmailSenderConfig, ResendDomainResponse, ResendDomainStatusResponse } from './interfaces/email-sender-config.interface';

@Injectable()
export class EmailService {
	private readonly logger = new Logger(EmailService.name);
	private readonly resendApiKey: string;
	private readonly resendApiUrl = 'https://api.resend.com';

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource
	) {
		this.resendApiKey = this.configService.get<string>('RESEND_API_KEY');
		if (!this.resendApiKey) {
			this.logger.warn('⚠️ RESEND_API_KEY no configurado en variables de entorno');
		}
	}

	async getSenderConfig(dto: GetSenderConfigDto): Promise<EmailSenderConfig | null> {
		try {
			const result = await this.dataSource.query(`SELECT * FROM holding_email_sender_settings WHERE holding_id = $1 LIMIT 1`, [dto.holding_id]);

			if (!result || result.length === 0) {
				return null;
			}

			return result[0];
		} catch (error) {
			this.logger.error('Error obteniendo configuración de email:', error);
			throw new InternalServerErrorException('Error al obtener configuración de email');
		}
	}

	async verifyDomain(dto: VerifyDomainDto, userId: string): Promise<EmailSenderConfig> {
		if (!this.resendApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const response = await fetch(`${this.resendApiUrl}/domains`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.resendApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: dto.sender_domain,
					region: 'us-east-1',
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error de Resend API:', errorData);
				throw new BadRequestException(errorData.message || 'Error al verificar dominio en Resend');
			}

			const resendData: ResendDomainResponse = await response.json();

			const existingConfig = await this.dataSource.query(`SELECT id FROM holding_email_sender_settings WHERE holding_id = $1 LIMIT 1`, [
				dto.holding_id,
			]);

			let savedConfig;

			if (existingConfig && existingConfig.length > 0) {
				savedConfig = await this.dataSource.query(
					`UPDATE holding_email_sender_settings 
					SET 
						sender_domain = $1,
						from_name = $2,
						from_email = $3,
						resend_domain_id = $4,
						domain_status = $5,
						domain_dns_records = $6,
						domain_verified_at = NULL,
						updated_at = NOW()
					WHERE holding_id = $7
					RETURNING *`,
					[
						dto.sender_domain,
						dto.from_name,
						dto.from_email,
						resendData.id,
						resendData.status,
						JSON.stringify(resendData.records),
						dto.holding_id,
					]
				);
			} else {
				savedConfig = await this.dataSource.query(
					`INSERT INTO holding_email_sender_settings 
					(holding_id, sender_domain, from_name, from_email, resend_domain_id, domain_status, domain_dns_records, created_by)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					RETURNING *`,
					[
						dto.holding_id,
						dto.sender_domain,
						dto.from_name,
						dto.from_email,
						resendData.id,
						resendData.status,
						JSON.stringify(resendData.records),
						userId,
					]
				);
			}

			this.logger.log(`✓ Dominio ${dto.sender_domain} registrado en Resend para holding ${dto.holding_id}`);

			return savedConfig[0];
		} catch (error) {
			if (error instanceof BadRequestException) {
				throw error;
			}
			this.logger.error('Error verificando dominio:', error);
			throw new InternalServerErrorException('Error al verificar dominio');
		}
	}

	async checkStatus(dto: CheckStatusDto): Promise<{ status: string; config: EmailSenderConfig }> {
		if (!this.resendApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const config = await this.getSenderConfig({ holding_id: dto.holding_id });

			if (!config) {
				throw new NotFoundException('No se encontró configuración de email para este holding');
			}

			if (!config.resend_domain_id) {
				throw new BadRequestException('No hay dominio registrado en Resend');
			}

			const response = await fetch(`${this.resendApiUrl}/domains/${config.resend_domain_id}`, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${this.resendApiKey}`,
				},
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error consultando estado en Resend:', errorData);
				throw new BadRequestException('Error al consultar estado del dominio');
			}

			const resendData: ResendDomainStatusResponse = await response.json();

			const updatedConfig = await this.dataSource.query(
				`UPDATE holding_email_sender_settings 
				SET 
					domain_status = $1,
					domain_dns_records = $2,
					domain_verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE domain_verified_at END,
					updated_at = NOW()
				WHERE holding_id = $3
				RETURNING *`,
				[resendData.status, JSON.stringify(resendData.records), dto.holding_id]
			);

			this.logger.log(`✓ Estado actualizado para holding ${dto.holding_id}: ${resendData.status}`);

			return {
				status: resendData.status,
				config: updatedConfig[0],
			};
		} catch (error) {
			if (error instanceof NotFoundException || error instanceof BadRequestException) {
				throw error;
			}
			this.logger.error('Error verificando estado:', error);
			throw new InternalServerErrorException('Error al verificar estado del dominio');
		}
	}

	async sendTestEmail(dto: SendTestEmailDto): Promise<{ message: string; note?: string }> {
		if (!this.resendApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const config = await this.getSenderConfig({ holding_id: dto.holding_id });

			if (!config) {
				throw new NotFoundException('No se encontró configuración de email para este holding');
			}

			if (config.domain_status !== 'verified') {
				throw new BadRequestException(
					`El dominio no está verificado. Estado actual: ${config.domain_status}. Configura los registros DNS y verifica el estado.`
				);
			}

			const response = await fetch(`${this.resendApiUrl}/emails`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.resendApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					from: `${config.from_name} <${config.from_email}>`,
					to: [dto.test_email],
					subject: 'Email de prueba - Sapira',
					html: `
						<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
							<h2>✓ Configuración de email exitosa</h2>
							<p>Este es un email de prueba enviado desde <strong>${config.sender_domain}</strong></p>
							<p>Tu configuración de email está funcionando correctamente.</p>
							<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
							<p style="color: #666; font-size: 12px;">
								Enviado desde Sapira<br>
								Dominio: ${config.sender_domain}<br>
								Remitente: ${config.from_name} &lt;${config.from_email}&gt;
							</p>
						</div>
					`,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error enviando email de prueba:', errorData);
				throw new BadRequestException(errorData.message || 'Error al enviar email de prueba');
			}

			await response.json();

			this.logger.log(`✓ Email de prueba enviado a ${dto.test_email} desde ${config.from_email}`);

			return {
				message: `Email de prueba enviado exitosamente a ${dto.test_email}`,
				note: 'Revisa tu bandeja de entrada (y spam) en los próximos minutos.',
			};
		} catch (error) {
			if (error instanceof NotFoundException || error instanceof BadRequestException) {
				throw error;
			}
			this.logger.error('Error enviando email de prueba:', error);
			throw new InternalServerErrorException('Error al enviar email de prueba');
		}
	}
}

import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

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
import {
	DnsRecord,
	DomainWithSenders,
	EmailSenderAddress,
	EmailSenderConfig,
	SendGridDomainResponse,
	SendGridDomainValidationResponse,
} from './interfaces/email-sender-config.interface';

@Injectable()
export class EmailsService {
	private readonly logger = new Logger(EmailsService.name);
	private readonly sendgridApiKey: string;
	private readonly sendgridApiUrl = 'https://api.sendgrid.com/v3';

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource
	) {
		this.sendgridApiKey = this.configService.get<string>('SENDGRID_API_KEY');
		if (!this.sendgridApiKey) {
			this.logger.warn('⚠️ SENDGRID_API_KEY no configurado en variables de entorno');
		}
	}

	async listDomains(dto: ListDomainsDto): Promise<DomainWithSenders[]> {
		try {
			let query = `
				SELECT * FROM holding_email_sender_settings 
				WHERE holding_id = $1
			`;

			const params: any[] = [dto.holding_id];

			if (dto.active_only) {
				query += ` AND is_active = true`;
			}

			query += ` ORDER BY is_default DESC, created_at DESC`;

			const domains = await this.dataSource.query(query, params);

			const domainsWithSenders = await Promise.all(
				domains.map(async (domain: EmailSenderConfig) => {
					const senders = await this.dataSource.query(
						`SELECT * FROM email_sender_addresses 
						WHERE domain_config_id = $1 
						ORDER BY is_default DESC, created_at DESC`,
						[domain.id]
					);

					return {
						...domain,
						email_sender_addresses: senders,
					};
				})
			);

			return domainsWithSenders;
		} catch (error) {
			this.logger.error('Error listando dominios:', error);
			throw new InternalServerErrorException('Error al listar dominios');
		}
	}

	async verifyDomain(dto: VerifyDomainDto, userId: string): Promise<DomainWithSenders> {
		if (!this.sendgridApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const domainParts = dto.sender_domain.split('.');
			const isSubdomain = domainParts.length > 2;

			const requestBody: any = {
				domain: isSubdomain ? domainParts.slice(-2).join('.') : dto.sender_domain,
				automatic_security: true,
				default: false,
				custom_spf: false,
			};

			if (isSubdomain) {
				requestBody.subdomain = domainParts[0];
			}

			const response = await fetch(`${this.sendgridApiUrl}/whitelabel/domains`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.sendgridApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error de SendGrid API:', errorData);
				throw new BadRequestException(errorData.errors?.[0]?.message || 'Error al verificar dominio en SendGrid');
			}

			const sendgridData: SendGridDomainResponse = await response.json();

			const baseDomain = sendgridData.domain;

			const dnsRecords: DnsRecord[] = [
				{
					type: 'CNAME',
					name: sendgridData.dns.mail_cname.host,
					value: sendgridData.dns.mail_cname.data,
					status: 'pending',
				},
				{
					type: 'CNAME',
					name: sendgridData.dns.dkim1.host,
					value: sendgridData.dns.dkim1.data,
					status: 'pending',
				},
				{
					type: 'CNAME',
					name: sendgridData.dns.dkim2.host,
					value: sendgridData.dns.dkim2.data,
					status: 'pending',
				},
				{
					type: 'TXT',
					name: `_dmarc.${baseDomain}`,
					value: 'v=DMARC1; p=none; rua=mailto:dmarc@' + baseDomain,
					status: 'pending',
				},
			];

			let finalUserId = null;
			if (userId) {
				const userResult = await this.dataSource.query(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [userId]);
				if (userResult && userResult.length > 0) {
					finalUserId = userResult[0].id;
				}
			}

			const savedDomain = await this.dataSource.query(
				`INSERT INTO holding_email_sender_settings 
				(holding_id, sender_domain, resend_domain_id, domain_status, domain_dns_records, is_default, is_active, display_name, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				RETURNING *`,
				[
					dto.holding_id,
					dto.sender_domain,
					sendgridData.id.toString(),
					sendgridData.valid ? 'verified' : 'pending',
					JSON.stringify(dnsRecords),
					dto.is_default || false,
					true,
					dto.display_name || null,
					finalUserId,
				]
			);

			const domain = savedDomain[0];

			const savedSender = await this.dataSource.query(
				`INSERT INTO email_sender_addresses 
				(domain_config_id, from_name, from_email, is_default, is_active, purpose, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				RETURNING *`,
				[domain.id, dto.from_name, dto.from_email, true, true, 'general', finalUserId]
			);

			this.logger.log(`✓ Dominio ${dto.sender_domain} registrado en SendGrid para holding ${dto.holding_id}`);

			return {
				...domain,
				email_sender_addresses: savedSender,
			};
		} catch (error) {
			if (error instanceof BadRequestException) {
				throw error;
			}
			this.logger.error('Error verificando dominio:', error);
			throw new InternalServerErrorException('Error al verificar dominio');
		}
	}

	async checkStatus(dto: CheckStatusDto): Promise<{ status: string; config: DomainWithSenders }> {
		if (!this.sendgridApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const domains = await this.listDomains({ holding_id: dto.holding_id });
			const defaultDomain = domains.find((d) => d.is_default && d.is_active);

			if (!defaultDomain) {
				throw new NotFoundException('No se encontró configuración de email por defecto para este holding');
			}

			if (!defaultDomain.resend_domain_id) {
				throw new BadRequestException('No hay dominio registrado en SendGrid');
			}

			const response = await fetch(`${this.sendgridApiUrl}/whitelabel/domains/${defaultDomain.resend_domain_id}/validate`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.sendgridApiKey}`,
				},
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error consultando estado en SendGrid:', errorData);
				throw new BadRequestException('Error al consultar estado del dominio');
			}

			const validationData: SendGridDomainValidationResponse = await response.json();

			const dnsRecords: DnsRecord[] = defaultDomain.domain_dns_records || [];
			if (dnsRecords.length > 0) {
				dnsRecords[0].status = validationData.validation_results.mail_cname.valid ? 'verified' : 'pending';
				dnsRecords[1].status = validationData.validation_results.dkim1.valid ? 'verified' : 'pending';
				dnsRecords[2].status = validationData.validation_results.dkim2.valid ? 'verified' : 'pending';
			}

			const allValid = validationData.valid;
			const domainStatus = allValid ? 'verified' : 'pending';

			const updatedConfig = await this.dataSource.query(
				`UPDATE holding_email_sender_settings 
				SET 
					domain_status = $1,
					domain_dns_records = $2,
					domain_verified_at = CASE WHEN $1 = 'verified' THEN NOW() ELSE domain_verified_at END,
					updated_at = NOW()
				WHERE id = $3
				RETURNING *`,
				[domainStatus, JSON.stringify(dnsRecords), defaultDomain.id]
			);

			this.logger.log(`✓ Estado actualizado para holding ${dto.holding_id}: ${domainStatus}`);

			return {
				status: domainStatus,
				config: {
					...updatedConfig[0],
					email_sender_addresses: defaultDomain.email_sender_addresses,
				},
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
		if (!this.sendgridApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const domains = await this.listDomains({ holding_id: dto.holding_id });
			const defaultDomain = domains.find((d) => d.is_default && d.is_active);

			if (!defaultDomain) {
				throw new NotFoundException('No se encontró configuración de email por defecto para este holding');
			}

			if (defaultDomain.domain_status !== 'verified') {
				throw new BadRequestException(
					`El dominio no está verificado. Estado actual: ${defaultDomain.domain_status}. Configura los registros DNS y verifica el estado.`
				);
			}

			const defaultSender = defaultDomain.email_sender_addresses?.find((s) => s.is_default && s.is_active);

			if (!defaultSender) {
				throw new NotFoundException('No se encontró remitente por defecto para este dominio');
			}

			const response = await fetch(`${this.sendgridApiUrl}/mail/send`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.sendgridApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					personalizations: [
						{
							to: [{ email: dto.test_email }],
						},
					],
					from: {
						email: defaultSender.from_email,
						name: defaultSender.from_name,
					},
					subject: 'Email de prueba - Sapira',
					content: [
						{
							type: 'text/html',
							value: `
								<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
									<h2>✓ Configuración de email exitosa</h2>
									<p>Este es un email de prueba enviado desde <strong>${defaultDomain.sender_domain}</strong></p>
									<p>Tu configuración de email está funcionando correctamente.</p>
									<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
									<p style="color: #666; font-size: 12px;">
										Enviado desde Sapira<br>
										Dominio: ${defaultDomain.sender_domain}<br>
										Remitente: ${defaultSender.from_name} &lt;${defaultSender.from_email}&gt;
									</p>
								</div>
							`,
						},
					],
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error enviando email de prueba:', errorData);
				throw new BadRequestException(errorData.errors?.[0]?.message || 'Error al enviar email de prueba');
			}

			this.logger.log(`✓ Email de prueba enviado a ${dto.test_email} desde ${defaultSender.from_email}`);

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

	async createSenderAddress(dto: CreateSenderAddressDto, userId: string): Promise<EmailSenderAddress> {
		try {
			const domain = await this.dataSource.query(`SELECT * FROM holding_email_sender_settings WHERE id = $1 LIMIT 1`, [dto.domain_config_id]);

			if (!domain || domain.length === 0) {
				throw new NotFoundException('No se encontró el dominio especificado');
			}

			let finalUserId = null;
			if (userId) {
				const userResult = await this.dataSource.query(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [userId]);
				if (userResult && userResult.length > 0) {
					finalUserId = userResult[0].id;
				}
			}

			const result = await this.dataSource.query(
				`INSERT INTO email_sender_addresses 
				(domain_config_id, from_name, from_email, reply_to_email, purpose, is_default, is_active, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				RETURNING *`,
				[
					dto.domain_config_id,
					dto.from_name,
					dto.from_email,
					dto.reply_to_email || null,
					dto.purpose || null,
					dto.is_default || false,
					true,
					finalUserId,
				]
			);

			this.logger.log(`✓ Remitente ${dto.from_email} creado para dominio ${dto.domain_config_id}`);

			return result[0];
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}
			this.logger.error('Error creando remitente:', error);
			throw new InternalServerErrorException('Error al crear remitente');
		}
	}

	async listSenderAddresses(dto: ListSenderAddressesDto): Promise<EmailSenderAddress[]> {
		try {
			let query = `
				SELECT * FROM email_sender_addresses 
				WHERE domain_config_id = $1
			`;

			const params: any[] = [dto.domain_config_id];

			if (dto.active_only) {
				query += ` AND is_active = true`;
			}

			query += ` ORDER BY is_default DESC, created_at DESC`;

			const senders = await this.dataSource.query(query, params);

			return senders;
		} catch (error) {
			this.logger.error('Error listando remitentes:', error);
			throw new InternalServerErrorException('Error al listar remitentes');
		}
	}

	async updateDomain(domainId: string, dto: UpdateDomainDto): Promise<EmailSenderConfig> {
		try {
			const domain = await this.dataSource.query(`SELECT * FROM holding_email_sender_settings WHERE id = $1 LIMIT 1`, [domainId]);

			if (!domain || domain.length === 0) {
				throw new NotFoundException('No se encontró el dominio especificado');
			}

			if (dto.is_default === true) {
				await this.dataSource.query(
					`UPDATE holding_email_sender_settings 
					SET is_default = false, updated_at = NOW() 
					WHERE holding_id = $1 AND id != $2`,
					[domain[0].holding_id, domainId]
				);
			}

			const updates: string[] = [];
			const params: any[] = [];
			let paramIndex = 1;

			if (dto.display_name !== undefined) {
				updates.push(`display_name = $${paramIndex++}`);
				params.push(dto.display_name);
			}

			if (dto.is_default !== undefined) {
				updates.push(`is_default = $${paramIndex++}`);
				params.push(dto.is_default);
			}

			if (dto.is_active !== undefined) {
				updates.push(`is_active = $${paramIndex++}`);
				params.push(dto.is_active);
			}

			if (updates.length === 0) {
				return domain[0];
			}

			updates.push(`updated_at = NOW()`);
			params.push(domainId);

			const query = `
				UPDATE holding_email_sender_settings 
				SET ${updates.join(', ')}
				WHERE id = $${paramIndex}
				RETURNING *
			`;

			const result = await this.dataSource.query(query, params);

			this.logger.log(`✓ Dominio ${domainId} actualizado`);

			return result[0];
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}
			this.logger.error('Error actualizando dominio:', error);
			throw new InternalServerErrorException('Error al actualizar dominio');
		}
	}

	async updateSenderAddress(senderId: string, dto: UpdateSenderAddressDto): Promise<EmailSenderAddress> {
		try {
			const sender = await this.dataSource.query(`SELECT * FROM email_sender_addresses WHERE id = $1 LIMIT 1`, [senderId]);

			if (!sender || sender.length === 0) {
				throw new NotFoundException('No se encontró el remitente especificado');
			}

			if (dto.is_default === true) {
				await this.dataSource.query(
					`UPDATE email_sender_addresses 
					SET is_default = false, updated_at = NOW() 
					WHERE domain_config_id = $1 AND id != $2`,
					[sender[0].domain_config_id, senderId]
				);
			}

			const updates: string[] = [];
			const params: any[] = [];
			let paramIndex = 1;

			if (dto.from_name !== undefined) {
				updates.push(`from_name = $${paramIndex++}`);
				params.push(dto.from_name);
			}

			if (dto.from_email !== undefined) {
				updates.push(`from_email = $${paramIndex++}`);
				params.push(dto.from_email);
			}

			if (dto.reply_to_email !== undefined) {
				updates.push(`reply_to_email = $${paramIndex++}`);
				params.push(dto.reply_to_email);
			}

			if (dto.purpose !== undefined) {
				updates.push(`purpose = $${paramIndex++}`);
				params.push(dto.purpose);
			}

			if (dto.is_default !== undefined) {
				updates.push(`is_default = $${paramIndex++}`);
				params.push(dto.is_default);
			}

			if (dto.is_active !== undefined) {
				updates.push(`is_active = $${paramIndex++}`);
				params.push(dto.is_active);
			}

			if (updates.length === 0) {
				return sender[0];
			}

			updates.push(`updated_at = NOW()`);
			params.push(senderId);

			const query = `
				UPDATE email_sender_addresses 
				SET ${updates.join(', ')}
				WHERE id = $${paramIndex}
				RETURNING *
			`;

			const result = await this.dataSource.query(query, params);

			this.logger.log(`✓ Remitente ${senderId} actualizado`);

			return result[0];
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}
			this.logger.error('Error actualizando remitente:', error);
			throw new InternalServerErrorException('Error al actualizar remitente');
		}
	}

	async deleteDomain(dto: DeleteDomainDto): Promise<{ message: string }> {
		try {
			const domain = await this.dataSource.query(`SELECT * FROM holding_email_sender_settings WHERE id = $1 LIMIT 1`, [dto.domain_id]);

			if (!domain || domain.length === 0) {
				throw new NotFoundException('No se encontró el dominio especificado');
			}

			if (domain[0].resend_domain_id && this.sendgridApiKey) {
				try {
					const response = await fetch(`${this.sendgridApiUrl}/whitelabel/domains/${domain[0].resend_domain_id}`, {
						method: 'DELETE',
						headers: {
							Authorization: `Bearer ${this.sendgridApiKey}`,
						},
					});

					if (!response.ok && response.status !== 404) {
						this.logger.warn(`No se pudo eliminar el dominio de SendGrid: ${response.status}`);
					}
				} catch (error) {
					this.logger.warn('Error al eliminar dominio de SendGrid:', error);
				}
			}

			await this.dataSource.query(`DELETE FROM holding_email_sender_settings WHERE id = $1`, [dto.domain_id]);

			this.logger.log(`✓ Dominio ${dto.domain_id} eliminado`);

			return {
				message: 'Dominio eliminado exitosamente',
			};
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}
			this.logger.error('Error eliminando dominio:', error);
			throw new InternalServerErrorException('Error al eliminar dominio');
		}
	}

	async deleteSenderAddress(dto: DeleteSenderAddressDto): Promise<{ message: string }> {
		try {
			const sender = await this.dataSource.query(`SELECT * FROM email_sender_addresses WHERE id = $1 LIMIT 1`, [dto.sender_id]);

			if (!sender || sender.length === 0) {
				throw new NotFoundException('No se encontró el remitente especificado');
			}

			await this.dataSource.query(`DELETE FROM email_sender_addresses WHERE id = $1`, [dto.sender_id]);

			this.logger.log(`✓ Remitente ${dto.sender_id} eliminado`);

			return {
				message: 'Remitente eliminado exitosamente',
			};
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}
			this.logger.error('Error eliminando remitente:', error);
			throw new InternalServerErrorException('Error al eliminar remitente');
		}
	}

	async send(params: { to: string; subject: string; html: string; from: string; fromName?: string; replyTo?: string }): Promise<void> {
		if (!this.sendgridApiKey) {
			throw new BadRequestException('Servicio de email no configurado. Contacte al administrador.');
		}

		try {
			const response = await fetch(`${this.sendgridApiUrl}/mail/send`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.sendgridApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					personalizations: [
						{
							to: [{ email: params.to }],
						},
					],
					from: {
						email: params.from,
						name: params.fromName || params.from,
					},
					reply_to: params.replyTo
						? {
								email: params.replyTo,
							}
						: undefined,
					subject: params.subject,
					content: [
						{
							type: 'text/html',
							value: params.html,
						},
					],
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				this.logger.error('Error enviando email:', errorData);
				throw new BadRequestException(errorData.errors?.[0]?.message || 'Error al enviar email');
			}

			this.logger.log(`✓ Email enviado a ${params.to}`);
		} catch (error) {
			if (error instanceof BadRequestException) {
				throw error;
			}
			this.logger.error('Error enviando email:', error);
			throw new InternalServerErrorException('Error al enviar email');
		}
	}
}

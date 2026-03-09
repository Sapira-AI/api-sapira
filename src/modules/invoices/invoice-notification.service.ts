import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailsService } from '@/modules/emails/emails.service';

import { Invoice } from './entities/invoice.entity';

interface ExchangeRateInfo {
	rate: number;
	requestedDate: Date | string;
	usedDate: Date | string;
	fromCurrency: string;
	toCurrency: string;
}

@Injectable()
export class InvoiceNotificationService {
	private readonly logger = new Logger(InvoiceNotificationService.name);
	private readonly adminEmails: string[];

	constructor(
		private readonly emailsService: EmailsService,
		private readonly configService: ConfigService
	) {
		const emailsConfig = this.configService.get<string>('INVOICE_ADMIN_EMAILS');
		this.adminEmails = emailsConfig ? emailsConfig.split(',').map((e) => e.trim()) : [];

		if (this.adminEmails.length === 0) {
			this.logger.warn('⚠️ INVOICE_ADMIN_EMAILS no configurado. No se enviarán notificaciones de facturas.');
		}
	}

	async sendExchangeRateFallbackNotification(invoice: Invoice, exchangeRateInfo: ExchangeRateInfo): Promise<void> {
		if (this.adminEmails.length === 0) {
			this.logger.warn('No hay emails configurados para notificaciones de facturas');
			return;
		}

		// Convertir fechas a string de forma segura
		const requestedDateStr = this.dateToString(exchangeRateInfo.requestedDate);
		const usedDateStr = this.dateToString(exchangeRateInfo.usedDate);

		const subject = `⚠️ Factura Emitida con Tipo de Cambio Fallback - ${invoice.invoice_number || invoice.id}`;

		const html = `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<style>
					body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
					.container { max-width: 600px; margin: 0 auto; padding: 20px; }
					.header { background-color: #ff9800; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
					.content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
					.warning-box { background-color: #fff3cd; border-left: 4px solid #ff9800; padding: 15px; margin: 15px 0; }
					.info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e9ecef; }
					.label { font-weight: bold; color: #495057; }
					.value { color: #ff9800; font-weight: bold; }
					.footer { background-color: #e9ecef; padding: 15px; border-radius: 0 0 5px 5px; font-size: 12px; color: #6c757d; }
				</style>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h2 style="margin: 0;">⚠️ Tipo de Cambio Fallback Utilizado</h2>
					</div>
					<div class="content">
						<p>Se ha emitido una factura utilizando un tipo de cambio de un día anterior debido a que no estaba disponible el tipo de cambio para la fecha de emisión solicitada.</p>
						
						<div class="warning-box">
							<h3 style="margin-top: 0; color: #ff9800;">Información de la Factura</h3>
							<div class="info-row">
								<span class="label">Número de Factura:</span>
								<span class="value">${invoice.invoice_number || invoice.id}</span>
							</div>
							<div class="info-row">
								<span class="label">ID de Factura:</span>
								<span>${invoice.id}</span>
							</div>
							<div class="info-row">
								<span class="label">Fecha de Emisión:</span>
								<span>${this.dateToString(invoice.issue_date)}</span>
							</div>
							<div class="info-row">
								<span class="label">Monto Contrato:</span>
								<span>${exchangeRateInfo.fromCurrency} ${this.formatCurrency(Number(invoice.amount_contract_currency))}</span>
							</div>
							<div class="info-row">
								<span class="label">Monto Factura:</span>
								<span>${exchangeRateInfo.toCurrency} ${this.formatCurrency(Number(invoice.amount_invoice_currency))}</span>
							</div>
						</div>

						<div class="warning-box" style="background-color: #fff; border-left-color: #dc3545;">
							<h3 style="margin-top: 0; color: #dc3545;">Tipo de Cambio Utilizado</h3>
							<div class="info-row">
								<span class="label">Conversión:</span>
								<span class="value">${exchangeRateInfo.fromCurrency} → ${exchangeRateInfo.toCurrency}</span>
							</div>
							<div class="info-row">
								<span class="label">Fecha Solicitada:</span>
								<span style="color: #dc3545; font-weight: bold;">${requestedDateStr}</span>
							</div>
							<div class="info-row">
								<span class="label">Fecha Utilizada (Fallback):</span>
								<span style="color: #ff9800; font-weight: bold;">${usedDateStr}</span>
							</div>
							<div class="info-row">
								<span class="label">Tipo de Cambio:</span>
								<span class="value">${exchangeRateInfo.rate.toFixed(6)}</span>
							</div>
						</div>

						<p><strong>⚠️ Nota Importante:</strong></p>
						<ul>
							<li>No había tipo de cambio disponible para la fecha de emisión (${requestedDateStr})</li>
							<li>Se utilizó el tipo de cambio del día hábil anterior más cercano (${usedDateStr})</li>
							<li>La factura fue emitida exitosamente con este tipo de cambio</li>
							<li>Revise si el tipo de cambio utilizado es aceptable para esta transacción</li>
						</ul>
					</div>
					<div class="footer">
						<p>Este es un mensaje automático del Sistema Sapira - Módulo de Facturación</p>
						<p>Si tiene alguna pregunta, contacte al administrador del sistema.</p>
					</div>
				</div>
			</body>
			</html>
		`;

		try {
			await this.emailsService.sendSystemEmail(this.adminEmails, subject, html);
			this.logger.log(
				`✓ Notificación de tipo de cambio fallback enviada a ${this.adminEmails.join(', ')} para factura ${invoice.invoice_number || invoice.id}`
			);
		} catch (error) {
			this.logger.error(`Error enviando notificación de tipo de cambio fallback para factura ${invoice.invoice_number || invoice.id}:`, error);
		}
	}

	async sendMissingExchangeRateNotification(invoice: Invoice, requestedDate: Date, fromCurrency: string, toCurrency: string): Promise<void> {
		if (this.adminEmails.length === 0) {
			this.logger.warn('No hay emails configurados para notificaciones de facturas');
			return;
		}

		const requestedDateStr = requestedDate.toISOString().split('T')[0];

		const subject = `🚨 Factura NO Emitida - Tipo de Cambio No Disponible - ${invoice.invoice_number || invoice.id}`;

		const html = `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<style>
					body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
					.container { max-width: 600px; margin: 0 auto; padding: 20px; }
					.header { background-color: #dc3545; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
					.content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
					.error-box { background-color: #fff; border-left: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
					.info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e9ecef; }
					.label { font-weight: bold; color: #495057; }
					.value { color: #dc3545; font-weight: bold; }
					.action-box { background-color: #d1ecf1; border-left: 4px solid #0c5460; padding: 15px; margin: 15px 0; }
					.footer { background-color: #e9ecef; padding: 15px; border-radius: 0 0 5px 5px; font-size: 12px; color: #6c757d; }
				</style>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h2 style="margin: 0;">🚨 Factura NO Emitida - Tipo de Cambio No Disponible</h2>
					</div>
					<div class="content">
						<p><strong>ATENCIÓN:</strong> No se pudo emitir la siguiente factura debido a que no hay tipo de cambio disponible para la fecha de emisión.</p>
						
						<div class="error-box">
							<h3 style="margin-top: 0; color: #dc3545;">Información de la Factura</h3>
							<div class="info-row">
								<span class="label">Número de Factura:</span>
								<span class="value">${invoice.invoice_number || invoice.id}</span>
							</div>
							<div class="info-row">
								<span class="label">ID de Factura:</span>
								<span>${invoice.id}</span>
							</div>
							<div class="info-row">
								<span class="label">Fecha de Emisión:</span>
								<span>${this.dateToString(invoice.issue_date)}</span>
							</div>
							<div class="info-row">
								<span class="label">Cliente:</span>
								<span>${invoice.client_entity_id || 'N/A'}</span>
							</div>
							<div class="info-row">
								<span class="label">Monto Contrato:</span>
								<span>${fromCurrency} ${this.formatCurrency(Number(invoice.amount_contract_currency))}</span>
							</div>
							<div class="info-row">
								<span class="label">Estado:</span>
								<span style="color: #dc3545; font-weight: bold;">Por Emitir (Bloqueada)</span>
							</div>
						</div>

						<div class="error-box">
							<h3 style="margin-top: 0; color: #dc3545;">Tipo de Cambio Requerido</h3>
							<div class="info-row">
								<span class="label">Conversión Requerida:</span>
								<span class="value">${fromCurrency} → ${toCurrency}</span>
							</div>
							<div class="info-row">
								<span class="label">Fecha Solicitada:</span>
								<span class="value">${requestedDateStr}</span>
							</div>
							<div class="info-row">
								<span class="label">Estado:</span>
								<span style="color: #dc3545; font-weight: bold;">NO DISPONIBLE</span>
							</div>
						</div>

						<div class="action-box">
							<h3 style="margin-top: 0; color: #0c5460;">⚡ Acción Requerida</h3>
							<p><strong>Para emitir esta factura, debe realizar una de las siguientes acciones:</strong></p>
							<ol>
								<li><strong>Opción 1:</strong> Ingresar manualmente el tipo de cambio ${fromCurrency}/${toCurrency} para la fecha ${requestedDateStr} en el sistema</li>
								<li><strong>Opción 2:</strong> Esperar a que el sistema sincronice automáticamente el tipo de cambio (si está disponible en la fuente de datos)</li>
								<li><strong>Opción 3:</strong> Cambiar la fecha de emisión de la factura a una fecha donde el tipo de cambio esté disponible</li>
							</ol>
							<p><strong>Una vez resuelto, el scheduler intentará emitir la factura automáticamente en la próxima ejecución.</strong></p>
						</div>

						<p><strong>🔍 Detalles Técnicos:</strong></p>
						<ul>
							<li>El sistema buscó el tipo de cambio para la fecha de emisión (${requestedDateStr})</li>
							<li>No se encontró tipo de cambio exacto ni fallback del día anterior</li>
							<li>La factura permanece en estado "Por Emitir" hasta que se resuelva</li>
							<li>No se envió a Odoo para evitar errores de facturación</li>
						</ul>
					</div>
					<div class="footer">
						<p>Este es un mensaje automático del Sistema Sapira - Módulo de Facturación</p>
						<p>Para más información, revise los logs del sistema o contacte al administrador.</p>
					</div>
				</div>
			</body>
			</html>
		`;

		try {
			await this.emailsService.sendSystemEmail(this.adminEmails, subject, html);
			this.logger.log(
				`✓ Notificación de tipo de cambio no disponible enviada a ${this.adminEmails.join(', ')} para factura ${invoice.invoice_number || invoice.id}`
			);
		} catch (error) {
			this.logger.error(
				`Error enviando notificación de tipo de cambio no disponible para factura ${invoice.invoice_number || invoice.id}:`,
				error
			);
		}
	}

	private formatCurrency(value: number): string {
		return new Intl.NumberFormat('es-CL', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(value);
	}

	private dateToString(date: Date | string | undefined | null): string {
		if (!date) return 'N/A';

		if (typeof date === 'string') {
			// Si ya es string, asumimos formato YYYY-MM-DD o ISO
			return date.split('T')[0];
		}

		if (date instanceof Date) {
			return date.toISOString().split('T')[0];
		}

		return 'N/A';
	}
}

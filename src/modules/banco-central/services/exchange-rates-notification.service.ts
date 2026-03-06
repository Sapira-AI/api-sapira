import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailsService } from '@/modules/emails/emails.service';

import { BancoCentralService } from '../banco-central.service';
import { SyncExchangeRatesResponseDto } from '../dtos/sync-exchange-rates.dto';
import { IndicadorEconomico } from '../interfaces/banco-central.interface';

interface EconomicIndicators {
	uf?: { value: number; date: string };
	dolar?: { value: number; date: string };
	tpm?: { value: number; date: string };
}

@Injectable()
export class ExchangeRatesNotificationService {
	private readonly logger = new Logger(ExchangeRatesNotificationService.name);
	private readonly adminEmails: string[];

	constructor(
		private readonly emailsService: EmailsService,
		private readonly configService: ConfigService,
		private readonly bancoCentralService: BancoCentralService
	) {
		const emailsConfig = this.configService.get<string>('BANCO_CENTRAL_ADMIN_EMAILS');
		this.adminEmails = emailsConfig ? emailsConfig.split(',').map((e) => e.trim()) : [];

		if (this.adminEmails.length === 0) {
			this.logger.warn('⚠️ BANCO_CENTRAL_ADMIN_EMAILS no configurado. No se enviarán notificaciones.');
		}
	}

	private async getEconomicIndicators(): Promise<EconomicIndicators> {
		const indicators: EconomicIndicators = {};

		try {
			const ufData = await this.bancoCentralService.getSeries({
				timeseries: IndicadorEconomico.UF,
				firstdate: this.getRecentDate(),
				lastdate: this.getTodayDate(),
			});
			if (ufData.Series?.Obs && ufData.Series.Obs.length > 0) {
				const latest = ufData.Series.Obs[ufData.Series.Obs.length - 1];
				indicators.uf = {
					value: parseFloat(latest.value),
					date: latest.indexDateString,
				};
			}
		} catch (error) {
			this.logger.warn('No se pudo obtener valor de UF:', error.message);
		}

		try {
			const dolarData = await this.bancoCentralService.getSeries({
				timeseries: IndicadorEconomico.DOLAR_OBSERVADO,
				firstdate: this.getRecentDate(),
				lastdate: this.getTodayDate(),
			});
			if (dolarData.Series?.Obs && dolarData.Series.Obs.length > 0) {
				const latest = dolarData.Series.Obs[dolarData.Series.Obs.length - 1];
				indicators.dolar = {
					value: parseFloat(latest.value),
					date: latest.indexDateString,
				};
			}
		} catch (error) {
			this.logger.warn('No se pudo obtener valor del Dólar:', error.message);
		}

		try {
			const tpmData = await this.bancoCentralService.getSeries({
				timeseries: IndicadorEconomico.TPM,
				firstdate: this.getRecentDate(),
				lastdate: this.getTodayDate(),
			});
			if (tpmData.Series?.Obs && tpmData.Series.Obs.length > 0) {
				const latest = tpmData.Series.Obs[tpmData.Series.Obs.length - 1];
				indicators.tpm = {
					value: parseFloat(latest.value),
					date: latest.indexDateString,
				};
			}
		} catch (error) {
			this.logger.warn('No se pudo obtener valor de TPM:', error.message);
		}

		return indicators;
	}

	private getRecentDate(): string {
		const date = new Date();
		date.setDate(date.getDate() - 7);
		return date.toISOString().split('T')[0];
	}

	private getTodayDate(): string {
		return new Date().toISOString().split('T')[0];
	}

	private formatCurrency(value: number): string {
		return new Intl.NumberFormat('es-CL', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(value);
	}

	private formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString('es-CL', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		});
	}

	async sendSyncFailureAlert(error: Error, context?: string): Promise<void> {
		if (this.adminEmails.length === 0) {
			this.logger.warn('No hay emails configurados para notificaciones');
			return;
		}

		const now = new Date();
		const dateStr = now.toLocaleDateString('es-CL', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});

		const subject = `🚨 Error en Sincronización de Tipos de Cambio - ${dateStr}`;

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
					.footer { background-color: #e9ecef; padding: 15px; border-radius: 0 0 5px 5px; font-size: 12px; color: #6c757d; }
					.label { font-weight: bold; color: #495057; }
					pre { background-color: #f1f3f5; padding: 10px; border-radius: 3px; overflow-x: auto; font-size: 12px; }
				</style>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h2 style="margin: 0;">🚨 Error en Sincronización de Tipos de Cambio</h2>
					</div>
					<div class="content">
						<p><span class="label">Fecha y hora:</span> ${dateStr}</p>
						${context ? `<p><span class="label">Contexto:</span> ${context}</p>` : ''}
						
						<div class="error-box">
							<p class="label">Tipo de error:</p>
							<p>${error.name || 'Error desconocido'}</p>
							
							<p class="label">Mensaje:</p>
							<p>${error.message}</p>
							
							${
								error.stack
									? `
								<p class="label">Stack trace:</p>
								<pre>${error.stack}</pre>
							`
									: ''
							}
						</div>
						
						<p><span class="label">⚠️ Acción requerida:</span></p>
						<ul>
							<li>Verificar conectividad con la API del Banco Central</li>
							<li>Revisar logs del sistema para más detalles</li>
							<li>Ejecutar sincronización manual si es necesario</li>
							<li>Contactar al equipo técnico si el problema persiste</li>
						</ul>
					</div>
					<div class="footer">
						<p>Este es un mensaje automático del Sistema Sapira - Módulo Banco Central</p>
						<p>Para más información, revise los logs del sistema o contacte al administrador.</p>
					</div>
				</div>
			</body>
			</html>
		`;

		try {
			await this.emailsService.sendSystemEmail(this.adminEmails, subject, html);
			this.logger.log(`✓ Alerta de error enviada a ${this.adminEmails.join(', ')}`);
		} catch (emailError) {
			this.logger.error('❌ Error enviando alerta de fallo por email:', {
				message: emailError?.message || 'Sin mensaje de error',
				name: emailError?.name || 'Error desconocido',
				stack: emailError?.stack || 'Sin stack trace',
				fullError: JSON.stringify(emailError, Object.getOwnPropertyNames(emailError)),
			});

			try {
				const errorSubject = `🚨 CRÍTICO: Fallo en Sistema de Emails - ${new Date().toLocaleString('es-CL')}`;
				const errorHtml = `
					<!DOCTYPE html>
					<html>
					<head>
						<meta charset="UTF-8">
						<style>
							body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
							.container { max-width: 600px; margin: 0 auto; padding: 20px; }
							.header { background-color: #dc3545; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
							.content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
							.error-box { background-color: #fff3cd; border-left: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
							pre { background-color: #f1f3f5; padding: 10px; border-radius: 3px; overflow-x: auto; font-size: 11px; }
						</style>
					</head>
					<body>
						<div class="container">
							<div class="header">
								<h2 style="margin: 0;">🚨 FALLO CRÍTICO: Sistema de Emails No Funciona</h2>
							</div>
							<div class="content">
								<p><strong>⚠️ El sistema de emails de Sapira no está funcionando correctamente.</strong></p>
								<p>Se intentó enviar una alerta de error pero falló el envío.</p>
								
								<div class="error-box">
									<p><strong>Tipo de error:</strong> ${emailError?.name || 'Error desconocido'}</p>
									<p><strong>Mensaje:</strong> ${emailError?.message || 'Sin mensaje'}</p>
									<p><strong>Contexto:</strong> Intentando enviar alerta de sincronización de tipos de cambio</p>
									
									${emailError?.stack ? `<p><strong>Stack trace:</strong></p><pre>${emailError.stack}</pre>` : ''}
									
									<p><strong>Error completo:</strong></p>
									<pre>${JSON.stringify(emailError, Object.getOwnPropertyNames(emailError), 2)}</pre>
								</div>
								
								<h3>Verificaciones necesarias:</h3>
								<ul>
									<li>✓ Verificar variable SENDGRID_API_KEY en .env</li>
									<li>✓ Verificar variable SYSTEM_EMAIL_FROM en .env</li>
									<li>✓ Verificar variable BANCO_CENTRAL_ADMIN_EMAILS en .env</li>
									<li>✓ Verificar que el dominio esté verificado en SendGrid</li>
									<li>✓ Verificar que la API key de SendGrid sea válida</li>
									<li>✓ Revisar logs del servidor para más detalles</li>
								</ul>
							</div>
						</div>
					</body>
					</html>
				`;

				await this.emailsService.sendSystemEmail(this.adminEmails, errorSubject, errorHtml);
				this.logger.log('✓ Alerta de fallo de email enviada exitosamente');
			} catch (secondaryError) {
				this.logger.error('❌ CRÍTICO: No se pudo enviar ni siquiera la alerta de fallo de email:', {
					message: secondaryError?.message || 'Sin mensaje',
					stack: secondaryError?.stack || 'Sin stack trace',
				});
			}
		}
	}

	async sendSyncSuccessReport(result: SyncExchangeRatesResponseDto, executionTime: number): Promise<void> {
		const sendSuccessReport = this.configService.get<string>('BANCO_CENTRAL_SEND_SUCCESS_REPORT') === 'true';

		if (!sendSuccessReport) {
			this.logger.debug('Reportes de éxito desactivados');
			return;
		}

		if (this.adminEmails.length === 0) {
			this.logger.warn('No hay emails configurados para notificaciones');
			return;
		}

		const indicators = await this.getEconomicIndicators();

		const now = new Date();
		const dateStr = now.toLocaleDateString('es-CL', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});

		const subject = `✅ Sincronización de Tipos de Cambio Completada - ${dateStr}`;

		const executionTimeStr =
			executionTime > 60000 ? `${(executionTime / 60000).toFixed(2)} minutos` : `${(executionTime / 1000).toFixed(2)} segundos`;

		const html = `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<style>
					body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
					.container { max-width: 600px; margin: 0 auto; padding: 20px; }
					.header { background-color: #28a745; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
					.content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
					.stats-box { background-color: #fff; padding: 15px; margin: 15px 0; border-radius: 5px; }
					.stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e9ecef; }
					.stat-label { font-weight: bold; color: #495057; }
					.stat-value { color: #28a745; font-weight: bold; }
					.footer { background-color: #e9ecef; padding: 15px; border-radius: 0 0 5px 5px; font-size: 12px; color: #6c757d; }
				</style>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h2 style="margin: 0;">✅ Sincronización Completada Exitosamente</h2>
					</div>
					<div class="content">
						<p><span class="stat-label">Fecha y hora:</span> ${dateStr}</p>
						<p><span class="stat-label">Estado:</span> ${result.success ? '✓ Exitoso' : '✗ Con errores'}</p>
						<p>${result.message}</p>
						
						${
							indicators.uf || indicators.dolar || indicators.tpm
								? `
						<div class="stats-box" style="background-color: #e7f3ff; border-left: 4px solid #0066cc;">
							<h3 style="margin-top: 0; color: #0066cc;">💰 Indicadores Económicos Principales - Chile</h3>
							${
								indicators.uf
									? `
							<div class="stat-row">
								<span class="stat-label">UF (Unidad de Fomento):</span>
								<span class="stat-value" style="color: #0066cc;">$${this.formatCurrency(indicators.uf.value)}</span>
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-bottom: 8px;">
								Actualizado: ${this.formatDate(indicators.uf.date)}
							</div>
							`
									: ''
							}
							${
								indicators.dolar
									? `
							<div class="stat-row">
								<span class="stat-label">Dólar Observado (CLP):</span>
								<span class="stat-value" style="color: #0066cc;">$${this.formatCurrency(indicators.dolar.value)}</span>
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-bottom: 8px;">
								Actualizado: ${this.formatDate(indicators.dolar.date)}
							</div>
							`
									: ''
							}
							${
								indicators.tpm
									? `
							<div class="stat-row">
								<span class="stat-label">TPM (Tasa Política Monetaria):</span>
								<span class="stat-value" style="color: #0066cc;">${this.formatCurrency(indicators.tpm.value)}%</span>
							</div>
							<div style="font-size: 11px; color: #6c757d; margin-bottom: 8px;">
								Actualizado: ${this.formatDate(indicators.tpm.date)}
							</div>
							`
									: ''
							}
						</div>
						`
								: ''
						}
						
						<div class="stats-box">
							<h3 style="margin-top: 0;">📊 Estadísticas de Sincronización</h3>
							<div class="stat-row">
								<span class="stat-label">Total procesado:</span>
								<span class="stat-value">${result.stats.totalProcessed}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Registros insertados:</span>
								<span class="stat-value">${result.stats.inserted}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Registros actualizados:</span>
								<span class="stat-value">${result.stats.updated}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Conversiones indirectas:</span>
								<span class="stat-value">${result.stats.indirectConversions}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Errores:</span>
								<span class="stat-value" style="color: ${result.stats.errors > 0 ? '#dc3545' : '#28a745'};">${result.stats.errors}</span>
							</div>
							<div class="stat-row">
								<span class="stat-label">Tiempo de ejecución:</span>
								<span class="stat-value">${executionTimeStr}</span>
							</div>
						</div>
						
						${
							result.monthlyAveragesCalculated
								? `
							<div class="stats-box">
								<h3 style="margin-top: 0;">📈 Promedios Mensuales Calculados</h3>
								<div class="stat-row">
									<span class="stat-label">Períodos procesados:</span>
									<span class="stat-value">${result.monthlyAveragesCalculated.periods}</span>
								</div>
								<div class="stat-row">
									<span class="stat-label">Pares de monedas:</span>
									<span class="stat-value">${result.monthlyAveragesCalculated.currencyPairs}</span>
								</div>
							</div>
						`
								: ''
						}
					</div>
					<div class="footer">
						<p>Este es un reporte automático del Sistema Sapira - Módulo Banco Central</p>
						<p>La próxima sincronización se ejecutará mañana a las 8:00 AM</p>
					</div>
				</div>
			</body>
			</html>
		`;

		try {
			await this.emailsService.sendSystemEmail(this.adminEmails, subject, html);
			this.logger.log(`✓ Reporte de éxito enviado a ${this.adminEmails.join(', ')}`);
		} catch (emailError) {
			this.logger.error('Error enviando reporte de éxito por email:', emailError);
		}
	}
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';
import type { CreateAppNotificationDto } from '@/modules/notifications/dtos/create-app-notification.dto';
import { NotificationEmailService } from '@/modules/notifications/notification-email.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import type { ProcessInvoicesResponseDto } from './dtos/send-invoices.dto';
import type { ExecutionEnvironment, ExecutionSource } from './schemas/invoice-scheduler-job.schema';

interface ExchangeRateInfo {
	rate: number;
	requestedDate: Date | string;
	usedDate: Date | string;
	fromCurrency: string;
	toCurrency: string;
}

export const INVOICE_FX_FALLBACK_NOTIFICATION_TYPE = 'invoice_fx_fallback';
export const INVOICE_FX_MISSING_NOTIFICATION_TYPE = 'invoice_fx_missing';
export const SCHEDULER_ERROR_SUMMARY_NOTIFICATION_TYPE = 'scheduler_error_summary';

const day = (value: Date | string | null | undefined): string => {
	if (!value) return 'sin fecha';
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'sin fecha' : value.toISOString().slice(0, 10);

	return String(value).slice(0, 10);
};

/**
 * Correos internos de facturación (Notificaciones v2 fase 2, contrato §8.5) **como alertas del catálogo**: factura emitida con tasa de
 * respaldo (`invoice_fx_fallback`), factura no emitida por falta de tasa (`invoice_fx_missing`) y resumen de errores del scheduler
 * (`scheduler_error_summary`). Destinatarios: suscripciones del tipo (super admins por defecto); el correo sale por el canal nuevo (Resend +
 * plantilla de marca, texto escapado). **Respaldo**: si la alerta no tiene destinatarios (semilla sin aplicar), el mismo correo de marca va a
 * `INVOICE_ADMIN_EMAILS`. Nunca lanza: un aviso que falla no detiene la emisión.
 */
@Injectable()
export class InvoiceNotificationService {
	private readonly logger = new Logger(InvoiceNotificationService.name);
	private readonly fallbackEmails: string[];

	constructor(
		private readonly notifications: NotificationsService,
		private readonly emails: NotificationEmailService,
		private readonly configService: ConfigService
	) {
		const emailsConfig = this.configService.get<string>('INVOICE_ADMIN_EMAILS');
		this.fallbackEmails = emailsConfig
			? emailsConfig
					.split(',')
					.map((e) => e.trim())
					.filter(Boolean)
			: [];
	}

	async sendExchangeRateFallbackNotification(invoice: Invoice, info: ExchangeRateInfo): Promise<void> {
		const folio = invoice.invoice_number || 'sin número';

		await this.notify(invoice.holding_id, {
			source: 'invoices',
			type: INVOICE_FX_FALLBACK_NOTIFICATION_TYPE,
			severity: 'warning',
			title: `Factura ${folio} emitida con tasa de respaldo (${info.fromCurrency}/${info.toCurrency})`,
			message:
				`No había tipo de cambio ${info.fromCurrency}/${info.toCurrency} para el ${day(info.requestedDate)}: la factura ${folio} se ` +
				`valorizó con el último disponible, del ${day(info.usedDate)} (${info.rate}).`,
			recommendation: 'Revisa la factura y, si la diferencia importa, ajústala.',
			action_type: 'open_invoice',
			action_payload: { invoice_id: invoice.id, contract_id: invoice.contract_id ?? null },
			resource_type: 'invoice',
			resource_id: invoice.id,
			...(invoice.company_id ? { company_id: invoice.company_id } : {}),
			metadata: {
				invoice_number: invoice.invoice_number ?? null,
				pair: `${info.fromCurrency}/${info.toCurrency}`,
				rate: info.rate,
				requested_date: day(info.requestedDate),
				used_date: day(info.usedDate),
			},
			deduplication_key: `invoice-fx-fallback:${invoice.id}:${info.fromCurrency}>${info.toCurrency}`,
		});
	}

	async sendMissingExchangeRateNotification(invoice: Invoice, requestedDate: Date, fromCurrency: string, toCurrency: string): Promise<void> {
		const folio = invoice.invoice_number || 'sin número';

		await this.notify(invoice.holding_id, {
			source: 'invoices',
			type: INVOICE_FX_MISSING_NOTIFICATION_TYPE,
			severity: 'error',
			title: `Factura ${folio} no emitida: falta el tipo de cambio ${fromCurrency}/${toCurrency}`,
			message: `No hay tipo de cambio ${fromCurrency}/${toCurrency} para el ${day(requestedDate)} ni uno anterior que sirva de respaldo.`,
			recommendation: 'Registra la tasa (o fija una en la factura) y vuelve a emitirla.',
			action_type: 'open_invoice',
			action_payload: { invoice_id: invoice.id, contract_id: invoice.contract_id ?? null },
			resource_type: 'invoice',
			resource_id: invoice.id,
			...(invoice.company_id ? { company_id: invoice.company_id } : {}),
			metadata: { invoice_number: invoice.invoice_number ?? null, pair: `${fromCurrency}/${toCurrency}`, requested_date: day(requestedDate) },
			deduplication_key: `invoice-fx-missing:${invoice.id}:${fromCurrency}>${toCurrency}`,
		});
	}

	/** Cierra "no emitida por falta de tasa" cuando la factura ya se envió bien. */
	async resolveMissingExchangeRate(holdingId: string, invoiceId: string): Promise<void> {
		try {
			await this.notifications.resolveOpen(holdingId, { type: INVOICE_FX_MISSING_NOTIFICATION_TYPE, resourceId: invoiceId });
		} catch (error) {
			this.logger.warn(
				`No se pudo cerrar el aviso de tasa faltante de ${invoiceId}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Resumen de la corrida real del scheduler: con errores crea (o actualiza) la alerta del día del holding; sin errores cierra la abierta.
	 * Las corridas de prueba (`dryRun`) no avisan.
	 */
	async sendSchedulerErrorSummary(params: {
		jobId: string;
		holdingId: string;
		dryRun: boolean;
		executionSource: ExecutionSource;
		executionEnvironment: ExecutionEnvironment;
		startedAt: Date;
		result: ProcessInvoicesResponseDto;
		distinctErrors: Array<{ message: string; count: number }>;
	}): Promise<void> {
		if (params.dryRun) return;
		if (params.result.summary.errors === 0) {
			try {
				await this.notifications.resolveOpen(params.holdingId, { type: SCHEDULER_ERROR_SUMMARY_NOTIFICATION_TYPE });
			} catch (error) {
				this.logger.warn(`No se pudo cerrar el resumen de errores del holding ${params.holdingId}: ${String(error)}`);
			}
			return;
		}
		const { summary } = params.result;
		const top = [...params.distinctErrors].sort((a, b) => b.count - a.count).slice(0, 5);

		await this.notify(params.holdingId, {
			source: 'invoices',
			type: SCHEDULER_ERROR_SUMMARY_NOTIFICATION_TYPE,
			severity: 'error',
			title: `La emisión ${params.executionSource === 'automatic' ? 'automática' : 'manual'} terminó con ${summary.errors} ${
				summary.errors === 1 ? 'factura con error' : 'facturas con error'
			}`,
			message:
				`De ${summary.total} facturas: ${summary.sent} enviadas, ${summary.errors} con error y ${summary.skipped} omitidas. ` +
				(top.length ? `Errores más frecuentes: ${top.map((error) => `${error.message} (${error.count})`).join('; ')}.` : ''),
			recommendation: 'Revisa las facturas con error en la cola Por Emitir.',
			action_type: 'open_billing_queue',
			action_payload: { href: '/facturacion?estado=Por+Emitir&grupo=blocked&periodo=todo' },
			metadata: {
				job_id: params.jobId,
				execution_source: params.executionSource,
				execution_environment: params.executionEnvironment,
				started_at: params.startedAt.toISOString(),
				finished_at:
					params.result.executedAt instanceof Date ? params.result.executedAt.toISOString() : String(params.result.executedAt ?? ''),
				summary,
				distinct_errors: params.distinctErrors.slice(0, 20),
			},
			// Una por holding y día: las corridas siguientes la actualizan (el correo no se repite salvo que escale).
			deduplication_key: `scheduler-errors:${params.holdingId}:${day(params.startedAt)}`,
		});
	}

	/** Crea o actualiza la alerta; sin destinatarios, respaldo por correo a `INVOICE_ADMIN_EMAILS`. Nunca lanza. */
	private async notify(holdingId: string, dto: CreateAppNotificationDto): Promise<void> {
		try {
			const result = await this.notifications.createOrUpdate(holdingId, dto);

			if (!result.notification && this.fallbackEmails.length) {
				await this.emails.sendAlertToAddresses(
					this.fallbackEmails,
					{
						id: dto.deduplication_key ?? dto.type,
						holding_id: holdingId,
						type: dto.type,
						severity: dto.severity ?? 'error',
						title: dto.title,
						message: dto.message,
						recommendation: dto.recommendation ?? null,
						company_id: dto.company_id ?? null,
						metadata: dto.metadata ?? {},
					},
					`fallback:${dto.deduplication_key ?? dto.type}`
				);
			}
		} catch (error) {
			this.logger.error(
				`No se pudo crear el aviso ${dto.type} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}

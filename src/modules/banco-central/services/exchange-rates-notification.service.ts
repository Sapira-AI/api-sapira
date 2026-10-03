import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NotificationEmailService } from '@/modules/notifications/notification-email.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

export const FX_SYNC_FAILURE_NOTIFICATION_TYPE = 'fx_sync_failure';
export const FX_SYNC_FAILURE_KEY = 'fx-sync-failure';

type Row = Record<string, unknown>;

/** Mensaje de error sin trazas ni saltos (va a la alerta y al correo). */
const shortError = (error: unknown) =>
	(error instanceof Error ? error.message : String(error ?? 'Error desconocido')).replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Avisos de la sincronización de tipos de cambio (Notificaciones v2 fase 2, contrato §8.5).
 *
 * - **Falla** → alerta `fx_sync_failure` en **todos los holdings** (los tipos de cambio son globales): Administrador, Admin Técnico y super
 *   admins (suscripciones del catálogo). Una abierta por holding (`fx-sync-failure`); el correo usa `metadata.email_group` por día, así un
 *   super admin con varios holdings recibe uno solo. **Respaldo**: si ningún holding tiene destinatarios, correo de marca a
 *   `BANCO_CENTRAL_ADMIN_EMAILS`.
 * - **Éxito** → cierra las alertas abiertas. El reporte diario de éxito **ya no se envía por correo** (se ve en Configuración › Monedas);
 *   `BANCO_CENTRAL_SEND_SUCCESS_REPORT` queda sin efecto.
 *
 * Nunca lanza: un aviso que falla no afecta la sincronización.
 */
@Injectable()
export class ExchangeRatesNotificationService {
	private readonly logger = new Logger(ExchangeRatesNotificationService.name);
	private readonly fallbackEmails: string[];

	constructor(
		private readonly configService: ConfigService,
		private readonly notifications: NotificationsService,
		private readonly emails: NotificationEmailService,
		@InjectDataSource() private readonly dataSource: DataSource
	) {
		const emailsConfig = this.configService.get<string>('BANCO_CENTRAL_ADMIN_EMAILS');
		this.fallbackEmails = emailsConfig
			? emailsConfig
					.split(',')
					.map((e) => e.trim())
					.filter(Boolean)
			: [];
	}

	async sendSyncFailureAlert(error: Error, context?: string): Promise<void> {
		const today = new Date().toISOString().slice(0, 10);
		const detail = shortError(error);
		const base = {
			source: 'banco-central',
			type: FX_SYNC_FAILURE_NOTIFICATION_TYPE,
			severity: 'error' as const,
			title: 'Falló la sincronización de tipos de cambio',
			message: `No pudimos traer los tipos de cambio del ${today}${context ? ` (${context.toLowerCase()})` : ''}. Las facturas en otra moneda pueden quedar sin tasa.`,
			recommendation: 'Si emites facturas en otra moneda hoy, revisa la tasa antes de emitir o fija una en la factura.',
			action_type: 'review_fx_rates',
			action_payload: { href: '/lab/configuracion?tab=monedas' },
			metadata: { error_message: detail, context: context ?? null, email_group: `${FX_SYNC_FAILURE_KEY}:${today}` },
			deduplication_key: FX_SYNC_FAILURE_KEY,
		};
		let delivered = 0;

		try {
			for (const holdingId of await this.holdingIds()) {
				try {
					const result = await this.notifications.createOrUpdate(holdingId, base);

					if (result.notification) delivered += 1;
				} catch (holdingError) {
					this.logger.warn(`Aviso de tipos de cambio (holding ${holdingId}): ${shortError(holdingError)}`);
				}
			}
		} catch (listError) {
			this.logger.error(`No se pudieron listar los holdings para el aviso de tipos de cambio: ${shortError(listError)}`);
		}
		if (!delivered && this.fallbackEmails.length) {
			await this.emails.sendAlertToAddresses(
				this.fallbackEmails,
				{ id: `${FX_SYNC_FAILURE_KEY}:${today}`, holding_id: '', ...base, company_id: null },
				`fallback:${FX_SYNC_FAILURE_KEY}:${today}`
			);
		}
	}

	/**
	 * Sincronización buena: cierra las alertas abiertas de falla (todas las de los holdings). Ya no envía el reporte de éxito por correo.
	 */
	async sendSyncSuccessReport(): Promise<void> {
		try {
			for (const holdingId of await this.holdingIds()) {
				await this.notifications.resolveByDeduplicationKey(holdingId, FX_SYNC_FAILURE_KEY);
			}
		} catch (error) {
			this.logger.warn(`No se pudieron cerrar los avisos de tipos de cambio: ${shortError(error)}`);
		}
	}

	/** Correo de prueba (`POST /banco-central/exchange-rates/test-notification-error`, solo super admin): plantilla de marca a una dirección. */
	async sendTestFailureEmail(to: string): Promise<number> {
		const today = new Date().toISOString().slice(0, 10);

		return this.emails.sendAlertToAddresses(
			[to],
			{
				id: `fx-test:${today}`,
				holding_id: '',
				type: FX_SYNC_FAILURE_NOTIFICATION_TYPE,
				severity: 'error',
				title: 'Prueba: falló la sincronización de tipos de cambio',
				message: 'Este es un correo de prueba del aviso de falla de sincronización. No hubo una falla real.',
				recommendation: 'No tienes que hacer nada.',
				company_id: null,
				metadata: {},
			},
			`fx-test:${to}:${Date.now()}`
		);
	}

	private async holdingIds(): Promise<string[]> {
		const rows = (await this.dataSource.query(`SELECT id FROM company_holdings ORDER BY id`)) as Row[];

		return (rows ?? []).map((row) => String(row.id));
	}
}

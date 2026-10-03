import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuthMailer, MailResult } from '@/auth/accounts/auth-mailer';
import { renderAlertEmail } from '@/auth/accounts/email-templates/alert';
import { RenderedEmail } from '@/auth/accounts/email-templates/layout';
import type { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import type { NotificationEmailKind } from '@/databases/postgresql/entities/automatizaciones-ia/notification-email-log.entity';

import { defaultEmailFor, moduleOfType, NOTIFICATION_MODULES, notificationCatalogEntry, resolveTexts, SEVERITY_LABELS } from './notification-catalog';

type Row = Record<string, unknown>;

/** Front de producción si falta `INVITE_LANDING_URL` (el botón nunca queda sin destino). */
export const DEFAULT_APP_URL = 'https://www.aisapira.com';

export interface EmailRecipient {
	id: string;
	email: string;
	name: string | null;
	role_name: string | null;
	is_super_admin: boolean;
}

type AlertLike = Pick<AppNotification, 'id' | 'holding_id' | 'type' | 'severity' | 'title' | 'message'> &
	Partial<Pick<AppNotification, 'recommendation' | 'metadata' | 'company_id'>>;

/**
 * Correos de Notificaciones v2 (fase 2, contrato §8.3 y §8.4): un solo canal (Resend por `AuthMailer`, plantillas de marca) para la alerta
 * inmediata y el resumen semanal. Deduplica con `notification_email_log` (UNIQUE `user_id, dedup_key`): la fila se **reserva antes de
 * enviar**, así una alerta no se reenvía salvo escalamiento y dos réplicas no duplican el resumen. Llave general
 * `NOTIFICATION_EMAILS_ENABLED` (default activo; `false` apaga). **Nunca lanza**: un correo que falla no rompe al productor.
 */
@Injectable()
export class NotificationEmailService {
	private readonly logger = new Logger(NotificationEmailService.name);

	constructor(
		@InjectDataSource() private readonly dataSource: DataSource,
		private readonly mailer: AuthMailer,
		private readonly config: ConfigService
	) {}

	get enabled(): boolean {
		return this.config.get<string>('NOTIFICATION_EMAILS_ENABLED') !== 'false';
	}

	/** URL del front nuevo (o la de producción si falta `INVITE_LANDING_URL`). */
	appUrl(path: string): string {
		return this.mailer.appUrl(path) ?? `${DEFAULT_APP_URL}${path.startsWith('/') ? path : `/${path}`}`;
	}

	alertUrl(notificationId: string): string {
		return this.appUrl(`/lab/notificaciones?alerta=${encodeURIComponent(notificationId)}`);
	}

	logoUrl(): string | undefined {
		return this.mailer.brandLogoUrl();
	}

	/** Usuarios activos con correo, con su rol (para los defaults) y super admin. */
	async recipients(userIds: string[]): Promise<EmailRecipient[]> {
		const unique = [...new Set(userIds)];

		if (!unique.length) return [];
		const rows = (await this.dataSource.query(
			`SELECT u.id, u.email, u.name, COALESCE(u.is_super_admin, false) AS is_super_admin, r.name AS role_name
			FROM users u LEFT JOIN roles r ON r.id = u.role_id
			WHERE u.id = ANY($1::uuid[]) AND u.status = 'Activo' AND COALESCE(u.email, '') <> ''`,
			[unique]
		)) as Row[];

		return (rows ?? []).map((row) => ({
			id: String(row.id),
			email: String(row.email),
			name: row.name ? String(row.name) : null,
			role_name: row.role_name ? String(row.role_name) : null,
			is_super_admin: row.is_super_admin === true,
		}));
	}

	/** Quienes quieren correo para el tipo: preferencia guardada o, sin fila, el default del catálogo (§8.2). */
	async wantEmail(holdingId: string, type: string, users: EmailRecipient[]): Promise<EmailRecipient[]> {
		if (!users.length) return [];
		const rows = (await this.dataSource.query(
			`SELECT user_id, email FROM user_notification_preferences WHERE holding_id = $1 AND notification_type = $2 AND user_id = ANY($3::uuid[])`,
			[holdingId, type, users.map((user) => user.id)]
		)) as Row[];
		const stored = new Map((rows ?? []).map((row) => [String(row.user_id), row.email === true]));

		return users.filter((user) => (stored.has(user.id) ? stored.get(user.id) : defaultEmailFor(type, user)));
	}

	/**
	 * Correo inmediato de una alerta a los destinatarios indicados (ya filtrados por membresía y compañía) que lo quieren. Clave de dedup:
	 * `alert:<id>:<gravedad>:<escalón>`; las alertas que llegan a varios holdings usan `metadata.email_group` (`alert-group:<grupo>`).
	 */
	async sendAlert(notification: AlertLike, userIds: string[], options: { escalated?: boolean } = {}): Promise<number> {
		if (!this.enabled || !userIds.length) return 0;
		try {
			const users = await this.wantEmail(notification.holding_id, notification.type, await this.recipients(userIds));

			if (!users.length) return 0;
			const email = renderAlertEmail({ ...(await this.alertValues(notification)), escalated: options.escalated }, {});
			const group = notification.metadata?.email_group;
			const key =
				typeof group === 'string' && group
					? `alert-group:${group}`
					: `alert:${notification.id}:${notification.severity}:${String(notification.metadata?.escalation_step ?? 0)}`;
			let sent = 0;

			for (const user of users) {
				const result = await this.deliver({
					holdingId: notification.holding_id,
					userId: user.id,
					to: user.email,
					kind: 'alert',
					key,
					notificationId: notification.id,
					email,
				});

				if (result === 'sent') sent += 1;
			}

			return sent;
		} catch (error) {
			this.logger.warn(`Correo de la alerta ${notification.id}: ${error instanceof Error ? error.message : String(error)}`);

			return 0;
		}
	}

	/** Respaldo de los correos internos (variables viejas `INVOICE_ADMIN_EMAILS` / `BANCO_CENTRAL_ADMIN_EMAILS`): misma plantilla, sin registro. */
	async sendAlertToAddresses(addresses: string[], notification: AlertLike, idempotencyKey: string): Promise<number> {
		if (!this.enabled || !addresses.length) return 0;
		try {
			// Sin alerta guardada: el botón va al centro de notificaciones.
			const email = renderAlertEmail({ ...(await this.alertValues(notification)), url: this.appUrl('/lab/notificaciones') });
			let sent = 0;

			for (const address of addresses) {
				const result = await this.mailer.sendRendered(address, email, `${idempotencyKey}:${address}`.slice(0, 250));

				if (result.status === 'sent') sent += 1;
			}

			return sent;
		} catch (error) {
			this.logger.warn(`Correo de respaldo (${notification.type}): ${error instanceof Error ? error.message : String(error)}`);

			return 0;
		}
	}

	/**
	 * Reserva la fila del log y envía. `skipped` si ya existía (deduplicado), `sent` o `failed` según Resend. La fila queda en `failed` (no
	 * se reintenta sola: la próxima escalada o semana tiene otra clave).
	 */
	async deliver(input: {
		holdingId: string;
		userId: string;
		to: string;
		kind: NotificationEmailKind;
		key: string;
		notificationId?: string | null;
		email: RenderedEmail;
	}): Promise<'sent' | 'failed' | 'skipped'> {
		const [claimed] = (await this.dataSource.query(
			`INSERT INTO notification_email_log (holding_id, user_id, kind, dedup_key, notification_id)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (user_id, dedup_key) DO NOTHING
			RETURNING id`,
			[input.holdingId, input.userId, input.kind, input.key, input.notificationId ?? null]
		)) as Row[];

		if (!claimed) return 'skipped';
		const result: MailResult = await this.mailer.sendRendered(input.to, input.email, `notif:${input.userId}:${input.key}`.slice(0, 250));

		await this.dataSource.query(
			`UPDATE notification_email_log SET status = $2, provider_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
			[claimed.id, result.status, result.status === 'sent' ? result.id : null, result.status === 'failed' ? result.error.slice(0, 500) : null]
		);

		return result.status;
	}

	private async alertValues(notification: AlertLike) {
		const [names] = (await this.dataSource.query(
			`SELECT (SELECT name FROM company_holdings WHERE id::text = $1) AS holding_name,
				(SELECT legal_name FROM companies WHERE id::text = $2) AS company_name`,
			[notification.holding_id || '', notification.company_id ?? '']
		)) as Row[];
		const texts = resolveTexts(notification);
		const entry = notificationCatalogEntry(notification.type);

		return {
			severityLabel: SEVERITY_LABELS[notification.severity] ?? 'Aviso',
			typeLabel: entry?.label ?? notification.title,
			moduleLabel: NOTIFICATION_MODULES[moduleOfType(notification.type)],
			title: notification.title,
			whatHappened: texts.what_happened,
			whatToDo: texts.what_to_do,
			whatWeDo: texts.what_we_do,
			companyName: names?.company_name ? String(names.company_name) : null,
			holdingName: names?.holding_name ? String(names.holding_name) : null,
			url: this.alertUrl(notification.id),
			logoUrl: this.logoUrl(),
		};
	}
}

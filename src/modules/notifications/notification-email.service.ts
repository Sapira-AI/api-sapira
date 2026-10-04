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

/** Ventana de espera de la alerta inmediata si falta `NOTIFICATION_EMAIL_DELAY_MINUTES`. */
export const DEFAULT_EMAIL_DELAY_MINUTES = 15;
/** `error` de la fila cuando la alerta se resolvió (o se borró) dentro de la ventana: no se envía. Sin estado nuevo (CHECK de la tabla). */
export const RESOLVED_BEFORE_SEND = 'resuelta antes de enviar';
/** `error` de la fila pendiente que reemplaza un escalamiento dentro de la ventana. */
export const SUPERSEDED_ERROR = 'reemplazada por escalamiento';

type AlertLike = Pick<AppNotification, 'id' | 'holding_id' | 'type' | 'severity' | 'title' | 'message'> &
	Partial<Pick<AppNotification, 'recommendation' | 'metadata' | 'company_id'>>;

/** Clave de dedup de la alerta inmediata: gravedad y escalón (vuelve a salir al escalar) o el grupo de las alertas de varios holdings. */
export function alertKey(notification: Pick<AppNotification, 'id' | 'severity'> & Partial<Pick<AppNotification, 'metadata'>>): string {
	const group = notification.metadata?.email_group;

	return typeof group === 'string' && group
		? `alert-group:${group}`
		: `alert:${notification.id}:${notification.severity}:${String(notification.metadata?.escalation_step ?? 0)}`;
}

/**
 * Correos de Notificaciones v2 (fase 2, contrato §8.3 y §8.4): un solo canal (Resend por `AuthMailer`, plantillas de marca) para la alerta
 * inmediata y el resumen semanal. Deduplica con `notification_email_log` (UNIQUE `user_id, dedup_key`): la fila se **reserva antes de
 * enviar**, así una alerta no se reenvía salvo escalamiento y dos réplicas no duplican el resumen. La alerta inmediata espera una ventana
 * (`NOTIFICATION_EMAIL_DELAY_MINUTES`, default 15) antes de salir: `queueAlert` reserva y `sendDueAlerts` (job) envía. Llave general
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
		return this.appUrl(`/notificaciones?alerta=${encodeURIComponent(notificationId)}`);
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
	 * Ventana de espera de la alerta inmediata (`NOTIFICATION_EMAIL_DELAY_MINUTES`, default 15): una alerta que se resuelve dentro de ella no
	 * genera correo, y si escala dentro de ella sale una sola vez, ya con el asunto de escalamiento.
	 */
	get delayMinutes(): number {
		const raw = this.config.get<string>('NOTIFICATION_EMAIL_DELAY_MINUTES');
		const value = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);

		return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EMAIL_DELAY_MINUTES;
	}

	/**
	 * **Reserva** (sin enviar) el correo inmediato de una alerta para los destinatarios indicados (ya filtrados por membresía y compañía) que
	 * lo quieren: una fila `pending` en `notification_email_log` por usuario. Lo envía `sendDueAlerts` (job cada 15 minutos) cuando la fila
	 * cumple la ventana de espera y la alerta sigue abierta. Clave de dedup: `alert:<id>:<gravedad>:<escalón>`; las alertas que llegan a
	 * varios holdings usan `metadata.email_group` (`alert-group:<grupo>`). Al **escalar**, la fila pendiente anterior del mismo usuario y
	 * alerta se reemplaza (`failed`, "reemplazada por escalamiento") y la nueva hereda su `created_at`: sale una sola vez, a la hora original.
	 * Devuelve cuántas filas reservó.
	 */
	async queueAlert(notification: AlertLike, userIds: string[], options: { escalated?: boolean } = {}): Promise<number> {
		if (!this.enabled || !userIds.length) return 0;
		try {
			const users = await this.wantEmail(notification.holding_id, notification.type, await this.recipients(userIds));

			if (!users.length) return 0;
			const key = alertKey(notification);
			let queued = 0;

			for (const user of users) {
				const [claimed] = (await this.dataSource.query(
					`INSERT INTO notification_email_log (holding_id, user_id, kind, dedup_key, notification_id, created_at)
					VALUES ($1, $2, 'alert', $3, $4, CASE WHEN $5::boolean THEN COALESCE((
						SELECT MIN(p.created_at) FROM notification_email_log p
						WHERE p.user_id = $2 AND p.notification_id = $4 AND p.kind = 'alert' AND p.status = 'pending' AND p.sent_at IS NULL
					), now()) ELSE now() END)
					ON CONFLICT (user_id, dedup_key) DO NOTHING
					RETURNING id`,
					[notification.holding_id, user.id, key, notification.id, options.escalated === true]
				)) as Row[];

				if (!claimed) continue;
				queued += 1;
				if (options.escalated) {
					await this.dataSource.query(
						`UPDATE notification_email_log SET status = 'failed', error = $4
						WHERE user_id = $1 AND notification_id = $2 AND kind = 'alert' AND status = 'pending' AND sent_at IS NULL AND id <> $3`,
						[user.id, notification.id, claimed.id, SUPERSEDED_ERROR]
					);
				}
			}

			return queued;
		} catch (error) {
			this.logger.warn(`Correo de la alerta ${notification.id}: ${error instanceof Error ? error.message : String(error)}`);

			return 0;
		}
	}

	/**
	 * Job de la alerta inmediata (cada 15 minutos, `NotificationJobsScheduler`): envía las filas `pending` de kind `alert` con `created_at`
	 * anterior a `now - delayMinutes` cuya alerta siga `open`. Si se resolvió (o se borró) en la ventana, la fila queda `failed` con
	 * `error = 'resuelta antes de enviar'` y no sale nada. El asunto dice "Sigue pendiente" si el usuario ya tenía otra fila de la misma
	 * alerta (escaló). Toma cada fila marcando `sent_at` antes de enviar (`pending` + `sent_at` = en envío): dos réplicas no duplican.
	 * Respeta `NOTIFICATION_EMAILS_ENABLED` (apagado no envía ni descarta: las filas esperan) y la allowlist de QA (`AuthMailer`). Nunca lanza.
	 */
	async sendDueAlerts(now = new Date(), limit = 500): Promise<{ sent: number; failed: number; discarded: number; skipped: number }> {
		const result = { sent: 0, failed: 0, discarded: 0, skipped: 0 };

		if (!this.enabled) return result;
		try {
			const cutoff = new Date(now.getTime() - this.delayMinutes * 60_000);
			const rows = (await this.dataSource.query(
				`SELECT l.id, l.user_id, l.dedup_key, l.notification_id, u.email, u.status AS user_status,
					EXISTS (
						SELECT 1 FROM notification_email_log p
						WHERE p.user_id = l.user_id AND p.notification_id = l.notification_id AND p.kind = 'alert' AND p.id <> l.id
							AND p.created_at <= l.created_at
					) AS escalated
				FROM notification_email_log l
				LEFT JOIN users u ON u.id = l.user_id
				WHERE l.kind = 'alert' AND l.status = 'pending' AND l.sent_at IS NULL AND l.created_at <= $1
				ORDER BY l.created_at
				LIMIT $2`,
				[cutoff, limit]
			)) as Row[];

			if (!rows?.length) return result;
			const ids = [
				...new Set(rows.map((row) => (row.notification_id ? String(row.notification_id) : null)).filter((id): id is string => !!id)),
			];
			const notifications = new Map(
				(ids.length
					? ((await this.dataSource.query(
							`SELECT id, holding_id, type, severity, title, message, recommendation, metadata, company_id, status
							FROM app_notifications WHERE id = ANY($1::uuid[])`,
							[ids]
						)) as Row[])
					: []
				).map((row) => [String(row.id), row])
			);
			const rendered = new Map<string, RenderedEmail>();

			for (const row of rows) {
				const id = String(row.id);
				const notification = row.notification_id ? notifications.get(String(row.notification_id)) : undefined;

				if (!notification || notification.status !== 'open') {
					await this.discard(id, RESOLVED_BEFORE_SEND);
					result.discarded += 1;
					continue;
				}
				if (row.user_status !== 'Activo' || !row.email) {
					await this.discard(id, 'usuario inactivo o sin correo');
					result.discarded += 1;
					continue;
				}
				const [taken] = (await this.dataSource.query(
					`UPDATE notification_email_log SET sent_at = now() WHERE id = $1 AND status = 'pending' AND sent_at IS NULL RETURNING id`,
					[id]
				)) as Row[];

				if (!taken) {
					result.skipped += 1;
					continue;
				}
				try {
					const escalated = row.escalated === true;
					const cacheKey = `${String(notification.id)}:${escalated}`;
					let email = rendered.get(cacheKey);

					if (!email) {
						email = renderAlertEmail({ ...(await this.alertValues(notification as unknown as AlertLike)), escalated });
						rendered.set(cacheKey, email);
					}
					const sent = await this.mailer.sendRendered(
						String(row.email),
						email,
						`notif:${String(row.user_id)}:${String(row.dedup_key)}`.slice(0, 250)
					);

					await this.finish(id, sent);
					result[sent.status] += 1;
				} catch (error) {
					await this.finish(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
					result.failed += 1;
				}
			}
			if (result.sent || result.failed || result.discarded) {
				this.logger.log(`Alertas por correo: ${result.sent} enviadas, ${result.failed} fallidas, ${result.discarded} descartadas`);
			}
		} catch (error) {
			this.logger.warn(`Alertas por correo pendientes: ${error instanceof Error ? error.message : String(error)}`);
		}

		return result;
	}

	/** Fila pendiente que no se enviará (alerta resuelta en la ventana, usuario inactivo): `failed` con el motivo. */
	private async discard(id: string, reason: string): Promise<void> {
		await this.dataSource.query(
			`UPDATE notification_email_log SET status = 'failed', error = $2 WHERE id = $1 AND status = 'pending' AND sent_at IS NULL`,
			[id, reason]
		);
	}

	/** Resultado de Resend en la fila: `sent` con `provider_id` y `sent_at`, o `failed` con el error (sin `sent_at`). */
	private async finish(id: string, result: MailResult): Promise<void> {
		await this.dataSource.query(
			`UPDATE notification_email_log SET status = $2, provider_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
			[id, result.status, result.status === 'sent' ? result.id : null, result.status === 'failed' ? result.error.slice(0, 500) : null]
		);
	}

	/** Respaldo de los correos internos (variables viejas `INVOICE_ADMIN_EMAILS` / `BANCO_CENTRAL_ADMIN_EMAILS`): misma plantilla, sin registro. */
	async sendAlertToAddresses(addresses: string[], notification: AlertLike, idempotencyKey: string): Promise<number> {
		if (!this.enabled || !addresses.length) return 0;
		try {
			// Sin alerta guardada: el botón va al centro de notificaciones.
			const email = renderAlertEmail({ ...(await this.alertValues(notification)), url: this.appUrl('/notificaciones') });
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
	 * Reserva la fila del log y envía en el acto (resumen semanal; la alerta inmediata usa `queueAlert` + `sendDueAlerts`). `skipped` si ya existía (deduplicado), `sent` o `failed` según Resend. La fila queda en `failed` (no
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

		await this.finish(String(claimed.id), result);

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

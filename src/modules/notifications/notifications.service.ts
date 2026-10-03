import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { AppNotificationRecipient } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification-recipient.entity';
import { AppNotification, AppNotificationSeverity } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import { NotificationRoleSubscription } from '@/databases/postgresql/entities/automatizaciones-ia/notification-role-subscription.entity';
import { UserHolding } from '@/databases/postgresql/entities/base-tenancy/user-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { userAvatar, type UserAvatar } from '@/modules/me/user-avatar';

import { CreateAppNotificationDto } from './dtos/create-app-notification.dto';
import {
	ListNotificationsDto,
	NotificationFiltersDto,
	ReplaceSalesforceStagingBlockedSubscriptionsDto,
	UpdateNotificationPreferencesDto,
} from './dtos/notifications.dto';
import {
	actionHref,
	defaultEmailFor,
	defaultWeeklyDigestFor,
	isCatalogType,
	moduleOfType,
	MY_COMPANIES_PREFERENCE,
	NOTIFICATION_ACTION_LABELS,
	NOTIFICATION_CATALOG,
	NOTIFICATION_MODULE_KEYS,
	NOTIFICATION_MODULES,
	notificationCatalogEntry,
	OFFERED_ROLE_NOTIFICATION_TYPES,
	PREFERENCE_NOTIFICATION_TYPES,
	resolveTexts,
	SEVERITY_LABELS,
	SEVERITY_RANK,
	typesOfModules,
	WEEKLY_DIGEST_PREFERENCE,
} from './notification-catalog';
import { NotificationEmailService } from './notification-email.service';
import { NotificationsGateway } from './notifications.gateway';

export const SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE = 'salesforce_staging_blocked';
export const SALESFORCE_SYNC_FAILURE_NOTIFICATION_TYPE = 'salesforce_sync_failure';
export const INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE = 'invoice_odoo_failure';
export const SYSTEM_UPDATE_NOTIFICATION_TYPE = 'system_update';
/**
 * Los 3 tipos de la ruta vieja `PUT /notifications/subscriptions/salesforce-staging-blocked` (front actual): esa ruta reemplaza solo estos,
 * así no borra las suscripciones nuevas. Configuración › Roles usa el catálogo (`OFFERED_ROLE_NOTIFICATION_TYPES`).
 */
export const ROLE_SUBSCRIPTION_NOTIFICATION_TYPES = [
	SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
	SALESFORCE_SYNC_FAILURE_NOTIFICATION_TYPE,
	INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE,
];
/** Nombre visible de cada tipo (del catálogo). */
export const ROLE_SUBSCRIPTION_NOTIFICATION_LABELS: Record<string, string> = Object.fromEntries(
	NOTIFICATION_CATALOG.map((item) => [item.type, item.label])
);

type Row = Record<string, unknown>;
type NotificationForRecipient = AppNotification & { is_read: boolean; read_at?: Date | null; archived_at?: Date | null };
export type NotificationView = ReturnType<typeof toView>;
type CreateResult = { notification: AppNotification | null; recipient_count: number };

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * "Mis compañías" (contrato §8.1) sobre `n` con `$1` = usuario y `$2` = holding: las alertas sin compañía siempre; las con compañía solo si
 * el usuario no filtró (sin fila o lista vacía) o la compañía está en su lista.
 */
export const MY_COMPANIES_SQL = `(n.company_id IS NULL OR NOT EXISTS (
	SELECT 1 FROM user_notification_preferences mc
	WHERE mc.user_id = $1 AND mc.holding_id = $2 AND mc.notification_type = '${MY_COMPANIES_PREFERENCE}'
		AND COALESCE(cardinality(mc.company_ids), 0) > 0 AND NOT (n.company_id = ANY(mc.company_ids))
))`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persona que provocó la alerta (quien mencionó, en `user_mention`). */
export interface NotificationActor {
	id: string;
	name: string;
	avatar: UserAvatar;
}

/**
 * Id de quien provocó la alerta: `metadata.actor_user_id` (genérico); las menciones creadas antes de ese campo guardaron el autor de la nota
 * en `metadata.author_id`. Sin un UUID válido, null.
 */
export function actorIdOf(row: { type?: string; metadata?: Record<string, unknown> | null }): string | null {
	const metadata = row.metadata ?? {};
	const raw = metadata.actor_user_id ?? (row.type === 'user_mention' ? metadata.author_id : null);

	return typeof raw === 'string' && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** Notificación + estado del destinatario → forma de la API (superconjunto de la de siempre). */
export function toView(row: NotificationForRecipient) {
	const catalog = notificationCatalogEntry(row.type);
	const module = moduleOfType(row.type);
	const actionType = row.action_type ?? null;

	return {
		...row,
		label: catalog?.label ?? row.title,
		module,
		module_label: NOTIFICATION_MODULES[module],
		icon: catalog?.icon ?? 'bell',
		severity_label: SEVERITY_LABELS[row.severity] ?? row.severity,
		action: actionType
			? {
					type: actionType,
					label: NOTIFICATION_ACTION_LABELS[actionType] ?? 'Abrir',
					payload: row.action_payload ?? {},
					href: actionHref(actionType, row.action_payload as Record<string, unknown> | null),
				}
			: null,
		integration_href: catalog?.integration_href ?? null,
		is_read: Boolean(row.is_read),
		read_at: row.read_at ?? null,
		is_archived: Boolean(row.archived_at),
		archived_at: row.archived_at ?? null,
	};
}

@Injectable()
export class NotificationsService {
	private readonly logger = new Logger(NotificationsService.name);

	constructor(
		@InjectRepository(AppNotification)
		private readonly notificationRepository: Repository<AppNotification>,
		@InjectRepository(AppNotificationRecipient)
		private readonly recipientRepository: Repository<AppNotificationRecipient>,
		@InjectRepository(NotificationRoleSubscription)
		private readonly roleSubscriptionRepository: Repository<NotificationRoleSubscription>,
		@InjectRepository(User)
		private readonly userRepository: Repository<User>,
		@InjectDataSource()
		private readonly dataSource: DataSource,
		private readonly notificationsGateway: NotificationsGateway,
		private readonly emails: NotificationEmailService
	) {}

	// ---------------------------------------------------------------- productores

	/**
	 * Crea una notificación con sus destinatarios: suscripciones del tipo + destinatarios explícitos, solo usuarios `Activo` con membresía
	 * activa en el holding y sin la preferencia `in_app` apagada para el tipo. **Sin destinatarios no inserta** (log `warn`, `notification:
	 * null`): una alerta que nadie ve no sirve y bloquearía la deduplicación; la próxima corrida la vuelve a intentar.
	 */
	async create(holdingId: string, dto: CreateAppNotificationDto): Promise<CreateResult> {
		if (dto.deduplication_key) {
			const duplicate = await this.notificationRepository.findOne({
				where: { holding_id: holdingId, deduplication_key: dto.deduplication_key, status: 'open' },
			});
			if (duplicate) {
				throw new ConflictException('Ya existe una notificación abierta con la misma clave de deduplicación');
			}
		}

		const userIds = await this.resolveRecipients(holdingId, dto);
		const companyId = userIds.length ? await this.companyOf(holdingId, dto) : null;

		if (!userIds.length) {
			this.logger.warn(
				`Notificación ${dto.type} del holding ${holdingId} sin destinatarios: no se crea (${dto.deduplication_key ?? dto.title})`
			);
			return { notification: null, recipient_count: 0 };
		}

		const result = await this.dataSource.transaction(async (manager) => {
			const notification = manager.create(AppNotification, {
				holding_id: holdingId,
				source: dto.source,
				type: dto.type,
				severity: this.severityOf(dto),
				title: dto.title,
				message: dto.message,
				recommendation: dto.recommendation || null,
				action_type: dto.action_type || null,
				action_payload: dto.action_payload || {},
				metadata: this.metadataOf(dto),
				deduplication_key: dto.deduplication_key || null,
				resource_type: dto.resource_type || null,
				resource_id: dto.resource_id || null,
				company_id: companyId,
			});
			const savedNotification = await manager.save(notification);

			await manager.insert(
				AppNotificationRecipient,
				userIds.map((userId) => ({
					notification_id: savedNotification.id,
					user_id: userId,
				}))
			);

			return { notification: savedNotification, recipient_count: userIds.length, recipientUserIds: userIds };
		});

		const visible = await this.visibleTo(holdingId, companyId, result.recipientUserIds);

		this.notificationsGateway.emitNotificationCreated(holdingId, visible, result.notification);
		// Correo inmediato: se reserva y sale tras la ventana de espera si la alerta sigue abierta (`sendDueAlerts`).
		await this.emails.queueAlert(result.notification, visible);
		return { notification: result.notification, recipient_count: result.recipient_count };
	}

	/**
	 * Con la misma `deduplication_key` abierta: actualiza título, mensaje, recomendación, acción y metadata; **suma destinatarios nuevos**
	 * (p. ej. un rol suscrito después); y si **sube la gravedad** o cambia el **escalón** (`escalation_step`) vuelve a "sin leer" y desarchiva
	 * para todos. Sin abierta, crea.
	 */
	async createOrUpdate(holdingId: string, dto: CreateAppNotificationDto): Promise<CreateResult> {
		if (dto.deduplication_key) {
			const existing = await this.notificationRepository.findOne({
				where: { holding_id: holdingId, deduplication_key: dto.deduplication_key, status: 'open' },
				relations: { recipients: true },
			});
			if (existing) {
				const severity = this.severityOf(dto);
				const previousStep = existing.metadata?.escalation_step;
				const escalated =
					SEVERITY_RANK[severity] > (SEVERITY_RANK[existing.severity] ?? 0) ||
					(dto.escalation_step !== undefined && previousStep !== undefined && String(previousStep) !== String(dto.escalation_step));
				const currentIds = (existing.recipients || []).map((recipient) => recipient.user_id);
				const resolved = await this.resolveRecipients(holdingId, dto);
				const newIds = resolved.filter((userId) => !currentIds.includes(userId));
				const companyId = (await this.companyOf(holdingId, dto)) ?? existing.company_id ?? null;

				await this.notificationRepository.update(existing.id, {
					severity,
					title: dto.title,
					message: dto.message,
					recommendation: dto.recommendation || null,
					action_type: dto.action_type || null,
					action_payload: dto.action_payload || {},
					metadata: this.metadataOf(dto),
					company_id: companyId,
					updated_at: new Date(),
				});
				if (newIds.length) {
					await this.recipientRepository
						.createQueryBuilder()
						.insert()
						.into(AppNotificationRecipient)
						.values(newIds.map((userId) => ({ notification_id: existing.id, user_id: userId })))
						.orIgnore()
						.execute();
				}
				if (escalated && currentIds.length) {
					await this.recipientRepository.update(
						{ notification_id: existing.id, user_id: In(currentIds) },
						{ is_read: false, read_at: null, archived_at: null }
					);
				}
				const notification = await this.notificationRepository.findOneByOrFail({ id: existing.id });
				const visibleNew = await this.visibleTo(holdingId, companyId, newIds);

				if (visibleNew.length) this.notificationsGateway.emitNotificationCreated(holdingId, visibleNew, notification);
				await this.emitUpdated(holdingId, currentIds, existing.id, companyId);
				// Correo (reservado, sale tras la ventana): a los nuevos siempre; a todos solo si escaló (la clave de dedup lleva gravedad y
				// escalón; la reserva pendiente anterior se reemplaza y sale una sola vez).
				const mailTo = escalated
					? [...visibleNew, ...(await this.visibleTo(holdingId, companyId, await this.activeMembers(holdingId, currentIds)))]
					: visibleNew;

				await this.emails.queueAlert(notification, mailTo, { escalated });
				return { notification, recipient_count: currentIds.length + newIds.length };
			}
		}

		return this.create(holdingId, dto);
	}

	async resolveByDeduplicationKey(holdingId: string, deduplicationKey: string): Promise<void> {
		await this.resolveOpen(holdingId, { deduplicationKeys: [deduplicationKey] });
	}

	/**
	 * Cierre automático genérico: resuelve las abiertas del holding que cumplen los criterios (tipo, recurso, claves). Devuelve cuántas
	 * cerró. Sin ningún criterio no hace nada (nunca cierra todo el holding).
	 */
	async resolveOpen(
		holdingId: string,
		criteria: { type?: string; resourceId?: string; deduplicationKeys?: string[]; ids?: string[] }
	): Promise<number> {
		if (!criteria.type && !criteria.resourceId && !criteria.deduplicationKeys?.length && !criteria.ids?.length) return 0;
		if (criteria.deduplicationKeys && !criteria.deduplicationKeys.length) return 0;
		if (criteria.ids && !criteria.ids.length) return 0;
		const where: Record<string, unknown> = { holding_id: holdingId, status: 'open' };

		if (criteria.type) where.type = criteria.type;
		if (criteria.resourceId) where.resource_id = criteria.resourceId;
		if (criteria.deduplicationKeys?.length) where.deduplication_key = In(criteria.deduplicationKeys);
		if (criteria.ids?.length) where.id = In(criteria.ids);
		const openNotifications = await this.notificationRepository.find({ where, relations: { recipients: true } });
		if (!openNotifications.length) {
			return 0;
		}

		await this.notificationRepository.update(
			{ id: In(openNotifications.map((notification) => notification.id)) },
			{ status: 'resolved', resolved_at: new Date() }
		);
		for (const notification of openNotifications) {
			await this.emitUpdated(
				holdingId,
				(notification.recipients || []).map((recipient) => recipient.user_id),
				notification.id,
				notification.company_id ?? null
			);
		}

		return openNotifications.length;
	}

	/** Abiertas de un tipo (y recurso): para que un módulo decida cuáles cerrar (p. ej. Contratos tras un cambio). */
	async listOpen(holdingId: string, type: string, resourceId?: string): Promise<AppNotification[]> {
		return this.notificationRepository.find({
			where: { holding_id: holdingId, type, status: 'open', ...(resourceId ? { resource_id: resourceId } : {}) },
		});
	}

	/**
	 * Novedad del sistema (`system_update`, canal listo; las novedades viven en el Centro de ayuda): a todos los miembros activos de los
	 * holdings indicados (o de todos). Acción `open_help { slug }`. Una por holding y `slug` (deduplicada).
	 */
	async notifySystemUpdate(input: {
		slug: string;
		title: string;
		message: string;
		holdingIds?: string[];
	}): Promise<{ slug: string; holdings: number; recipients: number }> {
		const holdingIds =
			input.holdingIds ?? ((await this.dataSource.query(`SELECT id FROM company_holdings ORDER BY id`)) as Row[]).map((row) => String(row.id));
		let created = 0;
		let recipients = 0;

		for (const holdingId of holdingIds) {
			const result = await this.createOrUpdate(holdingId, {
				source: 'system',
				type: SYSTEM_UPDATE_NOTIFICATION_TYPE,
				severity: 'info',
				title: input.title,
				message: input.message,
				action_type: 'open_help',
				action_payload: { slug: input.slug },
				deduplication_key: `system-update:${input.slug}`,
				recipients: { all_members: true },
			});
			if (result.notification) {
				created += 1;
				recipients += result.recipient_count;
			}
		}

		return { slug: input.slug, holdings: created, recipients };
	}

	/** Miembros activos del holding para mencionar (`GET /notifications/mentionable-users`). */
	async mentionableUsers(holdingId: string, search?: string, limit = 20) {
		const params: unknown[] = [holdingId];
		const like = search?.trim() ? `%${escapeLike(search.trim())}%` : null;

		if (like) params.push(like);
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT u.id, u.name, u.email, u.avatar_path, u.avatar_preset FROM users u JOIN user_holdings uh ON uh.user_id = u.id
			WHERE uh.holding_id = $1 AND uh.is_active = true AND u.status = 'Activo'${like ? ' AND (u.name ILIKE $2 OR u.email ILIKE $2)' : ''}
			ORDER BY u.name NULLS LAST, u.email
			LIMIT ${Math.min(Math.max(Number(limit) || 20, 1), 50)}`,
			params
		)) as Row[];

		return {
			data: (rows ?? []).map((row) => ({
				id: String(row.id),
				name: row.name ? String(row.name) : String(row.email),
				email: String(row.email),
				avatar: userAvatar(row),
			})),
		};
	}

	// ---------------------------------------------------------------- lectura del usuario

	async listForAuthenticatedUser(holdingId: string, authUserId: string, query: ListNotificationsDto) {
		const userId = await this.resolveInternalUserId(authUserId);
		const page = query.page || 1;
		const limit = query.limit || 20;
		const params: unknown[] = [userId, holdingId];
		const conditions = await this.filterConditions(holdingId, query, params);
		const [rows, [unread]] = await Promise.all([
			this.dataSource.query(
				`SELECT n.*, r.is_read, r.read_at, r.archived_at, COUNT(*) OVER () AS total_count
				FROM app_notification_recipients r
				JOIN app_notifications n ON n.id = r.notification_id
				WHERE r.user_id = $1 AND n.holding_id = $2${conditions.map((condition) => ` AND ${condition}`).join('')}
				ORDER BY n.created_at DESC, n.id
				LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COUNT(*) AS unread
				FROM app_notification_recipients r
				JOIN app_notifications n ON n.id = r.notification_id
				WHERE r.user_id = $1 AND n.holding_id = $2 AND r.is_read = false AND r.archived_at IS NULL AND ${MY_COMPANIES_SQL}`,
				[userId, holdingId]
			) as Promise<Row[]>,
		]);
		const total = Number(rows[0]?.total_count ?? 0);
		const data = await this.withActors(
			rows.map((row) => {
				const view = { ...row };

				delete view.total_count;
				return toView(view as unknown as NotificationForRecipient);
			})
		);

		return {
			data,
			total,
			items: total,
			currentPage: page,
			pages: Math.max(1, Math.ceil(total / limit)),
			limit,
			unread_count: Number(unread?.unread ?? 0),
			// Forma de siempre (front actual).
			pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
		};
	}

	async getForAuthenticatedUser(holdingId: string, authUserId: string, notificationId: string) {
		const userId = await this.resolveInternalUserId(authUserId);
		const [view] = await this.withActors([toView(await this.ownNotification(holdingId, userId, notificationId))]);

		return { ...view, texts: resolveTexts(view) };
	}

	async markAsRead(holdingId: string, authUserId: string, notificationId: string) {
		const userId = await this.resolveInternalUserId(authUserId);
		const current = await this.ownNotification(holdingId, userId, notificationId);

		if (current.is_read) {
			return toView(current);
		}

		const readAt = new Date();
		await this.recipientRepository.update({ notification_id: notificationId, user_id: userId }, { is_read: true, read_at: readAt });
		this.notificationsGateway.emitNotificationRead(userId, { holdingId, notificationId, read_at: readAt });
		return toView({ ...current, is_read: true, read_at: readAt });
	}

	async markAsUnread(holdingId: string, authUserId: string, notificationId: string) {
		const userId = await this.resolveInternalUserId(authUserId);
		const current = await this.ownNotification(holdingId, userId, notificationId);

		if (!current.is_read) return toView(current);
		await this.recipientRepository.update({ notification_id: notificationId, user_id: userId }, { is_read: false, read_at: null });
		this.notificationsGateway.emitNotificationUpdated([userId], { holdingId, notificationId });
		return toView({ ...current, is_read: false, read_at: null });
	}

	/** Marca como leídas las del usuario que cumplen los filtros (los de la lista; `read` se ignora). */
	async markAllAsRead(holdingId: string, authUserId: string, filters: NotificationFiltersDto): Promise<{ updated: number }> {
		const userId = await this.resolveInternalUserId(authUserId);
		const params: unknown[] = [userId, holdingId];
		const conditions = await this.filterConditions(holdingId, { ...filters, read: undefined }, params);
		const [row] = (await this.dataSource.query(
			`WITH target AS (
				SELECT r.id FROM app_notification_recipients r JOIN app_notifications n ON n.id = r.notification_id
				WHERE r.user_id = $1 AND n.holding_id = $2 AND r.is_read = false${conditions.map((condition) => ` AND ${condition}`).join('')}
			), done AS (
				UPDATE app_notification_recipients SET is_read = true, read_at = now() WHERE id IN (SELECT id FROM target) RETURNING 1
			)
			SELECT COUNT(*) AS updated FROM done`,
			params
		)) as Row[];
		const updated = Number(row?.updated ?? 0);

		if (updated) this.notificationsGateway.emitNotificationUpdated([userId], { holdingId, notificationId: '*' });
		return { updated };
	}

	/** Archiva (o desarchiva) para este usuario; las ajenas o de otro holding se ignoran. */
	async setArchived(holdingId: string, authUserId: string, ids: string[], archived: boolean): Promise<{ updated: number }> {
		const userId = await this.resolveInternalUserId(authUserId);
		const [row] = (await this.dataSource.query(
			`WITH done AS (
				UPDATE app_notification_recipients r SET archived_at = ${archived ? 'now()' : 'NULL'}
				FROM app_notifications n
				WHERE n.id = r.notification_id AND r.user_id = $1 AND n.holding_id = $2 AND r.notification_id = ANY($3::uuid[])
					AND r.archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
				RETURNING 1
			)
			SELECT COUNT(*) AS updated FROM done`,
			[userId, holdingId, ids]
		)) as Row[];
		const updated = Number(row?.updated ?? 0);

		if (updated) this.notificationsGateway.emitNotificationUpdated([userId], { holdingId, notificationId: '*' });
		return { updated };
	}

	/** Sin leer (fuera de archivadas): total, por módulo y por tipo. */
	async countsForAuthenticatedUser(holdingId: string, authUserId: string) {
		const userId = await this.resolveInternalUserId(authUserId);
		const rows = (await this.dataSource.query(
			`SELECT n.type, COUNT(*) AS unread
			FROM app_notification_recipients r JOIN app_notifications n ON n.id = r.notification_id
			WHERE r.user_id = $1 AND n.holding_id = $2 AND r.is_read = false AND r.archived_at IS NULL AND ${MY_COMPANIES_SQL}
			GROUP BY n.type`,
			[userId, holdingId]
		)) as Row[];
		const byType = rows.map((row) => ({
			type: String(row.type),
			label: notificationCatalogEntry(String(row.type))?.label ?? String(row.type),
			unread: Number(row.unread ?? 0),
		}));
		const byModule = NOTIFICATION_MODULE_KEYS.map((module) => ({
			module,
			label: NOTIFICATION_MODULES[module],
			unread: byType.filter((item) => moduleOfType(item.type) === module).reduce((sum, item) => sum + item.unread, 0),
		}));

		return { unread: byType.reduce((sum, item) => sum + item.unread, 0), by_module: byModule, by_type: byType };
	}

	catalog() {
		return {
			modules: NOTIFICATION_MODULE_KEYS.map((key) => ({ key, label: NOTIFICATION_MODULES[key] })),
			types: NOTIFICATION_CATALOG.map((item) => ({
				type: item.type,
				label: item.label,
				module: item.module,
				icon: item.icon,
				severity: item.severity,
				subscribable: item.subscribable,
				reserved: item.reserved,
				action_label: item.action_type ? (NOTIFICATION_ACTION_LABELS[item.action_type] ?? null) : null,
				integration_href: item.integration_href ?? null,
			})),
		};
	}

	// ---------------------------------------------------------------- preferencias del usuario

	async getPreferences(holdingId: string, authUserId: string) {
		const userId = await this.resolveInternalUserId(authUserId);
		return this.preferencesOf(holdingId, userId);
	}

	async updatePreferences(holdingId: string, authUserId: string, dto: UpdateNotificationPreferencesDto) {
		const userId = await this.resolveInternalUserId(authUserId);
		const invalid = (dto.types ?? []).map((item) => item.type).filter((type) => !PREFERENCE_NOTIFICATION_TYPES.includes(type));

		if (invalid.length) throw validationException([{ field: 'types', message: `Tipo de aviso no válido: ${invalid.join(', ')}` }]);
		if (dto.company_ids) {
			const companies = new Set((await this.holdingCompanies(holdingId)).map((company) => company.id));
			const foreign = dto.company_ids.filter((id) => !companies.has(id));

			if (foreign.length) throw validationException([{ field: 'company_ids', message: `Compañía no válida: ${foreign.join(', ')}` }]);
		}
		const current = await this.preferencesOf(holdingId, userId, { allTypes: true });
		const byType = new Map(current.types.map((item) => [item.type, item]));
		const rows: Array<{ type: string; in_app: boolean; email: boolean }> = (dto.types ?? []).map((item) => {
			const previous = byType.get(item.type)!;

			return { type: item.type, in_app: item.in_app ?? previous.in_app, email: item.email ?? previous.email };
		});

		if (dto.weekly_digest !== undefined) rows.push({ type: WEEKLY_DIGEST_PREFERENCE, in_app: false, email: dto.weekly_digest });
		for (const row of rows) {
			await this.dataSource.query(
				`INSERT INTO user_notification_preferences (user_id, holding_id, notification_type, in_app, email)
				VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (user_id, holding_id, notification_type) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email, updated_at = now()`,
				[userId, holdingId, row.type, row.in_app, row.email]
			);
		}
		if (dto.company_ids) {
			await this.dataSource.query(
				`INSERT INTO user_notification_preferences (user_id, holding_id, notification_type, in_app, email, company_ids)
				VALUES ($1, $2, $3, false, false, $4::uuid[])
				ON CONFLICT (user_id, holding_id, notification_type) DO UPDATE SET company_ids = EXCLUDED.company_ids, updated_at = now()`,
				[userId, holdingId, MY_COMPANIES_PREFERENCE, [...new Set(dto.company_ids)]]
			);
			this.notificationsGateway.emitNotificationUpdated([userId], { holdingId, notificationId: '*' });
		}

		return this.preferencesOf(holdingId, userId);
	}

	/** "Mis compañías" del usuario en el holding (`[]` = todas). La usan Tareas y el resumen semanal. */
	async myCompanies(holdingId: string, userId: string): Promise<string[]> {
		try {
			const [row] = (await this.dataSource.query(
				`SELECT company_ids FROM user_notification_preferences WHERE user_id = $1 AND holding_id = $2 AND notification_type = $3`,
				[userId, holdingId, MY_COMPANIES_PREFERENCE]
			)) as Row[];

			return Array.isArray(row?.company_ids) ? (row.company_ids as unknown[]).map(String) : [];
		} catch (error) {
			this.logger.warn(`No se pudo leer "Mis compañías": ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	/** `myCompanies` a partir del usuario autenticado. */
	async myCompaniesForAuthUser(holdingId: string, authUserId: string): Promise<string[]> {
		return this.myCompanies(holdingId, await this.resolveInternalUserId(authUserId));
	}

	private async holdingCompanies(holdingId: string): Promise<Array<{ id: string; name: string; country: string | null }>> {
		const rows = (await this.dataSource.query(`SELECT id, legal_name, country FROM companies WHERE holding_id = $1 ORDER BY legal_name`, [
			holdingId,
		])) as Row[];

		return (rows ?? []).map((row) => ({
			id: String(row.id),
			name: String(row.legal_name ?? ''),
			country: row.country ? String(row.country) : null,
		}));
	}

	private async preferencesOf(holdingId: string, userId: string, options: { allTypes?: boolean } = {}) {
		const [rows, [user], companies] = await Promise.all([
			this.dataSource.query(
				`SELECT notification_type, in_app, email, company_ids FROM user_notification_preferences WHERE user_id = $1 AND holding_id = $2`,
				[userId, holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COALESCE(u.is_super_admin, false) AS is_super_admin, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
				[userId]
			) as Promise<Row[]>,
			this.holdingCompanies(holdingId),
		]);
		const stored = new Map((rows ?? []).map((row) => [String(row.notification_type), row]));
		const profile = { is_super_admin: user?.is_super_admin === true, role_name: user?.role_name ? String(user.role_name) : null };
		const types = PREFERENCE_NOTIFICATION_TYPES.filter(
			(type) => options.allTypes || profile.is_super_admin || !notificationCatalogEntry(type)!.internal
		);
		const digestRow = stored.get(WEEKLY_DIGEST_PREFERENCE);
		const companyIds = stored.get(MY_COMPANIES_PREFERENCE)?.company_ids;

		return {
			weekly_digest: digestRow ? digestRow.email === true : defaultWeeklyDigestFor(profile.role_name),
			company_ids: Array.isArray(companyIds) ? companyIds.map(String) : [],
			companies,
			types: types.map((type) => {
				const entry = notificationCatalogEntry(type)!;
				const row = stored.get(type);

				return {
					type,
					label: entry.label,
					module: entry.module,
					module_label: NOTIFICATION_MODULES[entry.module],
					reserved: entry.reserved,
					in_app: row ? row.in_app !== false : true,
					email: row ? row.email === true : defaultEmailFor(type, profile),
				};
			}),
			defaults: {
				weekly_digest: defaultWeeklyDigestFor(profile.role_name),
				types: types.map((type) => ({ type, in_app: true, email: defaultEmailFor(type, profile) })),
			},
		};
	}

	// ---------------------------------------------------------------- suscripciones por rol

	async listSalesforceStagingBlockedSubscriptions(holdingId: string): Promise<NotificationRoleSubscription[]> {
		return this.roleSubscriptionRepository.find({
			where: { holding_id: holdingId, notification_type: In(ROLE_SUBSCRIPTION_NOTIFICATION_TYPES) },
			order: { created_at: 'ASC' },
		});
	}

	async assertCanManageSubscriptions(holdingId: string, authUserId: string): Promise<void> {
		const user = await this.userRepository.findOne({ where: { auth_id: authUserId } });
		if (!user) {
			throw new ForbiddenException('No se encontró el usuario autenticado');
		}
		const membership = await this.dataSource.query(
			`SELECT assigned_role.name AS role_name
			 FROM public.user_holdings membership
			 LEFT JOIN public.roles assigned_role ON assigned_role.id = $3 AND assigned_role.holding_id = $2
			 WHERE membership.user_id = $1
			 AND membership.holding_id = $2
			 AND membership.is_active = true
			 LIMIT 1`,
			[user.id, holdingId, user.role_id]
		);
		if (!membership.length) {
			throw new ForbiddenException('No tienes acceso al holding seleccionado');
		}
		if (!user.is_super_admin && membership[0].role_name !== 'Administrador') {
			throw new ForbiddenException('Solo Super Admin o Administrador puede configurar destinatarios de notificaciones');
		}
	}

	/** Ruta vieja (front actual): reemplaza las suscripciones de los 3 tipos de siempre, sin tocar las demás. */
	async replaceSalesforceStagingBlockedSubscriptions(
		holdingId: string,
		dto: ReplaceSalesforceStagingBlockedSubscriptionsDto
	): Promise<NotificationRoleSubscription[]> {
		const roleIds = [...new Set(dto.role_ids || [])];
		await this.ensureRolesBelongToHolding(holdingId, roleIds);

		return this.dataSource.transaction(async (manager) => {
			await manager.delete(NotificationRoleSubscription, {
				holding_id: holdingId,
				notification_type: In(ROLE_SUBSCRIPTION_NOTIFICATION_TYPES),
			});
			const recipientRoles = [...roleIds, ...(dto.include_super_admins ? [null] : [])];
			const subscriptions = ROLE_SUBSCRIPTION_NOTIFICATION_TYPES.flatMap((notificationType) =>
				recipientRoles.map((roleId) =>
					manager.create(NotificationRoleSubscription, {
						holding_id: holdingId,
						role_id: roleId,
						notification_type: notificationType,
					})
				)
			);
			return subscriptions.length ? manager.save(subscriptions) : [];
		});
	}

	/** Tipos que tiene activos un rol entre los que ofrece Configuración › Roles. El rol ya fue validado contra el holding. */
	async listRoleSubscriptionTypes(holdingId: string, roleId: string): Promise<string[]> {
		const rows = await this.roleSubscriptionRepository.find({
			where: { holding_id: holdingId, role_id: roleId, notification_type: In(OFFERED_ROLE_NOTIFICATION_TYPES), is_enabled: true },
		});
		return [...new Set(rows.map((row) => row.notification_type))];
	}

	/**
	 * Reemplaza las suscripciones de **un** rol entre los tipos ofrecidos (sin tocar otros roles, la de super admins `role_id NULL` ni los
	 * reservados de fase 2).
	 */
	async replaceRoleSubscriptionTypes(holdingId: string, roleId: string, types: string[]): Promise<string[]> {
		const unique = [...new Set(types)].filter((type) => OFFERED_ROLE_NOTIFICATION_TYPES.includes(type));
		await this.ensureRolesBelongToHolding(holdingId, [roleId]);
		await this.dataSource.transaction(async (manager) => {
			await manager.delete(NotificationRoleSubscription, {
				holding_id: holdingId,
				role_id: roleId,
				notification_type: In(OFFERED_ROLE_NOTIFICATION_TYPES),
			});
			if (unique.length) {
				await manager.save(
					unique.map((notificationType) =>
						manager.create(NotificationRoleSubscription, { holding_id: holdingId, role_id: roleId, notification_type: notificationType })
					)
				);
			}
		});
		return unique;
	}

	// ---------------------------------------------------------------- internos

	private severityOf(dto: CreateAppNotificationDto): AppNotificationSeverity {
		return dto.severity || notificationCatalogEntry(dto.type)?.severity || 'error';
	}

	/**
	 * Agrega `actor` (nombre y avatar de quien provocó la alerta, ver `actorIdOf`) a cada notificación, con una sola consulta por página.
	 * Sin actor o si la persona ya no existe: `actor: null`.
	 */
	private async withActors<T extends { type?: string; metadata?: Record<string, unknown> | null }>(
		views: T[]
	): Promise<Array<T & { actor: NotificationActor | null }>> {
		const ids = [...new Set(views.map(actorIdOf).filter((id): id is string => Boolean(id)))];
		const rows = ids.length
			? ((await this.dataSource.query(
					`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, avatar_path, avatar_preset FROM users WHERE id = ANY($1::uuid[])`,
					[ids]
				)) as Row[])
			: [];
		const byId = new Map(
			(rows ?? []).map((row) => [
				String(row.id).toLowerCase(),
				{ id: String(row.id), name: String(row.name ?? 'Alguien'), avatar: userAvatar(row) },
			])
		);

		return views.map((view) => {
			const id = actorIdOf(view);

			return { ...view, actor: (id && byId.get(id)) || null };
		});
	}

	private metadataOf(dto: CreateAppNotificationDto): Record<string, unknown> {
		return { ...(dto.metadata || {}), ...(dto.escalation_step !== undefined ? { escalation_step: dto.escalation_step } : {}) };
	}

	/** Condiciones SQL (sobre `r` y `n`) de los filtros; agrega los valores a `params`. */
	private async filterConditions(holdingId: string, filters: NotificationFiltersDto, params: unknown[]): Promise<string[]> {
		const add = (value: unknown) => {
			params.push(value);
			return `$${params.length}`;
		};
		// `$1` = usuario y `$2` = holding en todas las consultas de lectura: "Mis compañías" (§8.1).
		const conditions: string[] = [filters.archived ? 'r.archived_at IS NOT NULL' : 'r.archived_at IS NULL', MY_COMPANIES_SQL];

		if (filters.status) conditions.push(`n.status = ${add(filters.status)}`);
		if (filters.read !== undefined) conditions.push(`r.is_read = ${add(filters.read)}`);
		if (filters.type?.length) conditions.push(`n.type = ANY(${add(filters.type)}::text[])`);
		if (filters.module?.length) {
			const types = typesOfModules(filters.module);
			// Los tipos fuera del catálogo (heredados) cuentan como Sistema.
			const outside = filters.module.includes('sistema')
				? ` OR NOT (n.type = ANY(${add(NOTIFICATION_CATALOG.map((item) => item.type))}::text[]))`
				: '';

			conditions.push(`(n.type = ANY(${add(types)}::text[])${outside})`);
		}
		if (filters.severity?.length) conditions.push(`n.severity = ANY(${add(filters.severity)}::text[])`);
		if (filters.from || filters.to) {
			const zone = add(await holdingTimezone(this.dataSource, holdingId));

			if (filters.from) conditions.push(`(n.created_at AT TIME ZONE ${zone})::date >= ${add(filters.from)}::date`);
			if (filters.to) conditions.push(`(n.created_at AT TIME ZONE ${zone})::date <= ${add(filters.to)}::date`);
		}
		if (filters.search?.trim()) {
			const like = add(`%${escapeLike(filters.search.trim())}%`);

			conditions.push(`(n.title ILIKE ${like} OR n.message ILIKE ${like})`);
		}

		return conditions;
	}

	private async ownNotification(holdingId: string, userId: string, notificationId: string): Promise<NotificationForRecipient> {
		const recipient = await this.recipientRepository
			.createQueryBuilder('recipient')
			.innerJoinAndSelect('recipient.notification', 'notification')
			.where('recipient.notification_id = :notificationId', { notificationId })
			.andWhere('recipient.user_id = :userId', { userId })
			.andWhere('notification.holding_id = :holdingId', { holdingId })
			.getOne();
		if (!recipient) {
			throw new NotFoundException('Notificación no encontrada');
		}
		return { ...recipient.notification, is_read: recipient.is_read, read_at: recipient.read_at, archived_at: recipient.archived_at ?? null };
	}

	/** Avisa a los destinatarios que siguen siendo miembros activos del holding y ven la compañía (quien perdió la membresía no recibe nada). */
	private async emitUpdated(holdingId: string, userIds: string[], notificationId: string, companyId: string | null = null) {
		const members = await this.visibleTo(holdingId, companyId, await this.activeMembers(holdingId, userIds));

		if (members.length) this.notificationsGateway.emitNotificationUpdated(members, { holdingId, notificationId });
	}

	/**
	 * Destinatarios que ven una alerta de la compañía (§8.1): sin compañía, todos; con compañía, quien no filtró o la tiene en "Mis compañías".
	 * Si la columna no existe aún (N5 sin aplicar) no filtra a nadie.
	 */
	async visibleTo(holdingId: string, companyId: string | null | undefined, userIds: string[]): Promise<string[]> {
		const unique = [...new Set(userIds)];

		if (!companyId || !unique.length) return unique;
		try {
			const rows = (await this.dataSource.query(
				`SELECT user_id FROM user_notification_preferences
				WHERE holding_id = $1 AND notification_type = $2 AND user_id = ANY($3::uuid[])
					AND COALESCE(cardinality(company_ids), 0) > 0 AND NOT ($4::uuid = ANY(company_ids))`,
				[holdingId, MY_COMPANIES_PREFERENCE, unique, companyId]
			)) as Row[];
			const hidden = new Set((rows ?? []).map((row) => String(row.user_id)));

			return unique.filter((userId) => !hidden.has(userId));
		} catch (error) {
			this.logger.warn(`No se pudo leer "Mis compañías": ${error instanceof Error ? error.message : String(error)}`);
			return unique;
		}
	}

	/**
	 * Compañía de la alerta (§8.1): la del productor o, si no la trae, la del recurso (factura, contrato) o la del contrato del ítem
	 * (`metadata.contract_item_id`). Sin nada, null (la ve todo destinatario).
	 */
	private async companyOf(holdingId: string, dto: CreateAppNotificationDto): Promise<string | null> {
		if (dto.company_id) return dto.company_id;
		try {
			const itemId = typeof dto.metadata?.contract_item_id === 'string' ? dto.metadata.contract_item_id : null;
			let sql: string | null = null;
			let id: string | null = null;

			if (dto.resource_id && dto.resource_type === 'invoice') {
				sql = `SELECT company_id FROM invoices WHERE id = $1 AND holding_id = $2`;
				id = dto.resource_id;
			} else if (dto.resource_id && dto.resource_type === 'contract') {
				sql = `SELECT company_id FROM contracts WHERE id = $1 AND holding_id = $2`;
				id = dto.resource_id;
			} else if (itemId) {
				sql = `SELECT c.company_id FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id WHERE ci.id = $1 AND c.holding_id = $2`;
				id = itemId;
			}
			if (!sql || !id) return null;
			const [row] = (await this.dataSource.query(sql, [id, holdingId])) as Row[];

			return row?.company_id ? String(row.company_id) : null;
		} catch (error) {
			this.logger.warn(`No se pudo resolver la compañía de la alerta ${dto.type}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	private async activeMembers(holdingId: string, userIds: string[]): Promise<string[]> {
		const unique = [...new Set(userIds)];

		if (!unique.length) return [];
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT user_id FROM user_holdings WHERE holding_id = $1 AND is_active = true AND user_id = ANY($2::uuid[])`,
			[holdingId, unique]
		)) as Row[];

		return (rows ?? []).map((row) => String(row.user_id));
	}

	private async resolveInternalUserId(authUserId: string): Promise<string> {
		const user = await this.userRepository.findOne({ where: { auth_id: authUserId } });
		if (!user) {
			throw new NotFoundException('Usuario autenticado no encontrado');
		}
		return user.id;
	}

	/** Suscripciones del tipo + destinatarios explícitos − quien apagó el tipo en sus preferencias. */
	private async resolveRecipients(holdingId: string, dto: CreateAppNotificationDto): Promise<string[]> {
		const subscriptionRecipients = await this.roleSubscriptionRepository.find({
			where: { holding_id: holdingId, notification_type: dto.type, is_enabled: true },
		});
		const roleIds = [
			...new Set([
				...(dto.recipients?.role_ids || []),
				...subscriptionRecipients.flatMap((subscription) => (subscription.role_id ? [subscription.role_id] : [])),
			]),
		];
		const includeSuperAdmins =
			Boolean(dto.recipients?.include_super_admins) || subscriptionRecipients.some((subscription) => subscription.role_id === null);
		const userIds = await this.resolveActiveRecipientUserIds(
			holdingId,
			dto.recipients?.user_ids || [],
			roleIds,
			includeSuperAdmins,
			Boolean(dto.recipients?.all_members)
		);
		const muted = await this.mutedUsers(holdingId, dto.type, userIds);

		return userIds.filter((userId) => !muted.has(userId));
	}

	/** Usuarios con `in_app` apagado para el tipo. Sin la tabla (N2 sin aplicar) no silencia a nadie: un productor nunca falla por esto. */
	private async mutedUsers(holdingId: string, type: string, userIds: string[]): Promise<Set<string>> {
		if (!userIds.length || !isCatalogType(type)) return new Set();
		try {
			const rows = (await this.dataSource.query(
				`SELECT user_id FROM user_notification_preferences
				WHERE holding_id = $1 AND notification_type = $2 AND in_app = false AND user_id = ANY($3::uuid[])`,
				[holdingId, type, userIds]
			)) as Row[];

			return new Set((rows ?? []).map((row) => String(row.user_id)));
		} catch (error) {
			this.logger.warn(`No se pudieron leer las preferencias de notificación: ${error instanceof Error ? error.message : String(error)}`);
			return new Set();
		}
	}

	private async resolveActiveRecipientUserIds(
		holdingId: string,
		recipientUserIds: string[],
		roleIds: string[],
		includeSuperAdmins: boolean,
		allMembers = false
	): Promise<string[]> {
		if (!recipientUserIds.length && !roleIds.length && !includeSuperAdmins && !allMembers) {
			return [];
		}

		const conditions: string[] = [];
		const parameters: Record<string, unknown> = { holdingId, status: 'Activo' };
		if (allMembers) {
			conditions.push('true');
		}
		if (recipientUserIds.length) {
			conditions.push('user.id IN (:...recipientUserIds)');
			parameters.recipientUserIds = recipientUserIds;
		}
		if (roleIds.length) {
			conditions.push('user.role_id IN (:...roleIds)');
			parameters.roleIds = roleIds;
		}
		if (includeSuperAdmins) {
			conditions.push('user.is_super_admin = true');
		}

		const users = await this.userRepository
			.createQueryBuilder('user')
			.innerJoin(UserHolding, 'user_holding', 'user_holding.user_id = user.id')
			.select('user.id', 'id')
			.where('user_holding.holding_id = :holdingId', parameters)
			.andWhere('user_holding.is_active = true')
			.andWhere('user.status = :status')
			.andWhere(`(${conditions.join(' OR ')})`)
			.getRawMany<{ id: string }>();

		return [...new Set(users.map((user) => user.id))];
	}

	private async ensureRolesBelongToHolding(holdingId: string, roleIds: string[]): Promise<void> {
		if (!roleIds.length) {
			return;
		}
		const rows = await this.dataSource.query('SELECT id FROM public.roles WHERE holding_id = $1 AND id = ANY($2::uuid[])', [holdingId, roleIds]);
		if (rows.length !== roleIds.length) {
			throw new NotFoundException('Uno o más roles no pertenecen al holding');
		}
	}
}

import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { UserHolding } from '@/modules/holdings/entities/user-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

import { CreateAppNotificationDto } from './dtos/create-app-notification.dto';
import { ListNotificationsDto, ReplaceSalesforceStagingBlockedSubscriptionsDto } from './dtos/notifications.dto';
import { AppNotification } from './entities/app-notification.entity';
import { AppNotificationRecipient } from './entities/app-notification-recipient.entity';
import { NotificationRoleSubscription } from './entities/notification-role-subscription.entity';

export const SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE = 'salesforce_staging_blocked';
type NotificationForRecipient = AppNotification & { is_read: boolean; read_at?: Date | null };

@Injectable()
export class NotificationsService {
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
		private readonly dataSource: DataSource
	) {}

	async create(holdingId: string, dto: CreateAppNotificationDto): Promise<{ notification: AppNotification; recipient_count: number }> {
		if (dto.deduplication_key) {
			const duplicate = await this.notificationRepository.findOne({
				where: { holding_id: holdingId, deduplication_key: dto.deduplication_key, status: 'open' },
			});
			if (duplicate) {
				throw new ConflictException('Ya existe una notificación abierta con la misma clave de deduplicación');
			}
		}

		const subscriptionRecipients = await this.roleSubscriptionRepository.find({
			where: { holding_id: holdingId, notification_type: dto.type, is_enabled: true },
		});
		const recipientUserIds = dto.recipients?.user_ids || [];
		const roleIds = [
			...new Set([...(dto.recipients?.role_ids || []), ...subscriptionRecipients.flatMap((subscription) => (subscription.role_id ? [subscription.role_id] : []))]),
		];
		const includeSuperAdmins =
			Boolean(dto.recipients?.include_super_admins) || subscriptionRecipients.some((subscription) => subscription.role_id === null);
		const userIds = await this.resolveActiveRecipientUserIds(holdingId, recipientUserIds, roleIds, includeSuperAdmins);

		return this.dataSource.transaction(async (manager) => {
			const notification = manager.create(AppNotification, {
				holding_id: holdingId,
				source: dto.source,
				type: dto.type,
				severity: dto.severity || 'error',
				title: dto.title,
				message: dto.message,
				recommendation: dto.recommendation || null,
				action_type: dto.action_type || null,
				action_payload: dto.action_payload || {},
				metadata: dto.metadata || {},
				deduplication_key: dto.deduplication_key || null,
			});
			const savedNotification = await manager.save(notification);

			if (userIds.length) {
				await manager.insert(
					AppNotificationRecipient,
					userIds.map((userId) => ({
						notification_id: savedNotification.id,
						user_id: userId,
					}))
				);
			}

			return { notification: savedNotification, recipient_count: userIds.length };
		});
	}

	async createOrUpdate(holdingId: string, dto: CreateAppNotificationDto): Promise<{ notification: AppNotification; recipient_count: number }> {
		if (dto.deduplication_key) {
			const existing = await this.notificationRepository.findOne({
				where: { holding_id: holdingId, deduplication_key: dto.deduplication_key, status: 'open' },
				relations: { recipients: true },
			});
			if (existing) {
				await this.notificationRepository.update(existing.id, {
					severity: dto.severity || 'error',
					title: dto.title,
					message: dto.message,
					recommendation: dto.recommendation || null,
					action_type: dto.action_type || null,
					action_payload: dto.action_payload || {},
					metadata: dto.metadata || {},
				});
				const notification = await this.notificationRepository.findOneByOrFail({ id: existing.id });
				return {
					notification,
					recipient_count: existing.recipients?.length || 0,
				};
			}
		}

		return this.create(holdingId, dto);
	}

	async resolveByDeduplicationKey(holdingId: string, deduplicationKey: string): Promise<void> {
		await this.notificationRepository.update(
			{ holding_id: holdingId, deduplication_key: deduplicationKey, status: 'open' },
			{ status: 'resolved', resolved_at: new Date() }
		);
	}

	async listForAuthenticatedUser(
		holdingId: string,
		authUserId: string,
		query: ListNotificationsDto
	): Promise<{
		data: NotificationForRecipient[];
		pagination: { page: number; limit: number; total: number; total_pages: number };
		unread_count: number;
	}> {
		const userId = await this.resolveInternalUserId(authUserId);
		const page = query.page || 1;
		const limit = query.limit || 20;
		const [recipients, total] = await this.recipientRepository
			.createQueryBuilder('recipient')
			.innerJoinAndSelect('recipient.notification', 'notification')
			.where('recipient.user_id = :userId', { userId })
			.andWhere('notification.holding_id = :holdingId', { holdingId })
			.orderBy('notification.created_at', 'DESC')
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();
		const unreadCount = await this.recipientRepository
			.createQueryBuilder('recipient')
			.innerJoin('recipient.notification', 'notification')
			.where('recipient.user_id = :userId', { userId })
			.andWhere('recipient.is_read = false')
			.andWhere('notification.holding_id = :holdingId', { holdingId })
			.getCount();

		return {
			data: recipients.map((recipient) => ({
				...recipient.notification,
				is_read: recipient.is_read,
				read_at: recipient.read_at,
			})),
			pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
			unread_count: unreadCount,
		};
	}

	async getForAuthenticatedUser(holdingId: string, authUserId: string, notificationId: string): Promise<NotificationForRecipient> {
		const userId = await this.resolveInternalUserId(authUserId);
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
		return { ...recipient.notification, is_read: recipient.is_read, read_at: recipient.read_at };
	}

	async markAsRead(holdingId: string, authUserId: string, notificationId: string): Promise<NotificationForRecipient> {
		const userId = await this.resolveInternalUserId(authUserId);
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

		if (!recipient.is_read) {
			await this.recipientRepository.update(recipient.id, { is_read: true, read_at: new Date() });
		}
		return { ...recipient.notification, is_read: true, read_at: recipient.read_at || new Date() };
	}

	async listSalesforceStagingBlockedSubscriptions(holdingId: string): Promise<NotificationRoleSubscription[]> {
		return this.roleSubscriptionRepository.find({
			where: { holding_id: holdingId, notification_type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE },
			order: { created_at: 'ASC' },
		});
	}

	async assertCanManageSubscriptions(holdingId: string, authUserId: string): Promise<void> {
		const user = await this.userRepository.findOne({ where: { auth_id: authUserId } });
		if (!user?.is_super_admin) {
			throw new ForbiddenException('Solo Super Admin puede configurar destinatarios de notificaciones');
		}
		const membership = await this.dataSource.query(
			'SELECT 1 FROM public.user_holdings WHERE user_id = $1 AND holding_id = $2 AND is_active = true LIMIT 1',
			[user.id, holdingId]
		);
		if (!membership.length) {
			throw new ForbiddenException('No tienes acceso al holding seleccionado');
		}
	}

	async replaceSalesforceStagingBlockedSubscriptions(
		holdingId: string,
		dto: ReplaceSalesforceStagingBlockedSubscriptionsDto
	): Promise<NotificationRoleSubscription[]> {
		const roleIds = [...new Set(dto.role_ids || [])];
		await this.ensureRolesBelongToHolding(holdingId, roleIds);

		return this.dataSource.transaction(async (manager) => {
			await manager.delete(NotificationRoleSubscription, {
				holding_id: holdingId,
				notification_type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
			});
			const subscriptions = [
				...roleIds.map((roleId) =>
					manager.create(NotificationRoleSubscription, {
						holding_id: holdingId,
						role_id: roleId,
						notification_type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
					})
				),
				...(dto.include_super_admins
					? [
							manager.create(NotificationRoleSubscription, {
								holding_id: holdingId,
								role_id: null,
								notification_type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
							}),
						]
					: []),
			];
			return subscriptions.length ? manager.save(subscriptions) : [];
		});
	}

	private async resolveInternalUserId(authUserId: string): Promise<string> {
		const user = await this.userRepository.findOne({ where: { auth_id: authUserId } });
		if (!user) {
			throw new NotFoundException('Usuario autenticado no encontrado');
		}
		return user.id;
	}

	private async resolveActiveRecipientUserIds(
		holdingId: string,
		recipientUserIds: string[],
		roleIds: string[],
		includeSuperAdmins: boolean
	): Promise<string[]> {
		if (!recipientUserIds.length && !roleIds.length && !includeSuperAdmins) {
			return [];
		}

		const conditions: string[] = [];
		const parameters: Record<string, unknown> = { holdingId, status: 'Activo' };
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

import { ConflictException } from '@nestjs/common';

import { NotificationsService, SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE } from './notifications.service';

describe('NotificationsService', () => {
	const buildService = () => {
		const userQueryBuilder = {
			innerJoin: jest.fn().mockReturnThis(),
			select: jest.fn().mockReturnThis(),
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			getRawMany: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
		};
		const notificationRepository = { findOne: jest.fn(), find: jest.fn(), update: jest.fn(), findOneByOrFail: jest.fn() };
		const recipientQueryBuilder = {
			innerJoinAndSelect: jest.fn().mockReturnThis(),
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			getOne: jest.fn(),
		};
		const recipientRepository = { createQueryBuilder: jest.fn().mockReturnValue(recipientQueryBuilder), update: jest.fn() };
		const roleSubscriptionRepository = { find: jest.fn() };
		const userRepository = {
			findOne: jest.fn(),
			createQueryBuilder: jest.fn().mockReturnValue(userQueryBuilder),
		};
		const manager = {
			create: jest.fn((_entity, values) => ({ id: 'notification-1', ...values })),
			save: jest.fn(async (entity) => entity),
			insert: jest.fn(),
			delete: jest.fn(),
		};
		const dataSource = {
			query: jest.fn(),
			transaction: jest.fn(async (callback) => callback(manager)),
		};
		const notificationsGateway = {
			emitNotificationCreated: jest.fn(),
			emitNotificationRead: jest.fn(),
			emitNotificationUpdated: jest.fn(),
		};
		const service = new NotificationsService(
			notificationRepository as any,
			recipientRepository as any,
			roleSubscriptionRepository as any,
			userRepository as any,
			dataSource as any,
			notificationsGateway as any
		);

		return {
			service,
			notificationRepository,
			recipientRepository,
			recipientQueryBuilder,
			roleSubscriptionRepository,
			userRepository,
			userQueryBuilder,
			dataSource,
			notificationsGateway,
			manager,
		};
	};

	it('crea un evento y destinatarios activos derivados de suscripciones por rol', async () => {
		const { service, roleSubscriptionRepository, userQueryBuilder, manager } = buildService();
		roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);

		const result = await service.create('holding-1', {
			source: 'salesforce',
			type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
			title: 'Staging bloqueado',
			message: 'Hay registros bloqueados',
		});

		expect(userQueryBuilder.andWhere).toHaveBeenCalledWith('(user.role_id IN (:...roleIds))');
		expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [{ notification_id: 'notification-1', user_id: 'user-1' }]);
		expect(result.recipient_count).toBe(1);
	});

	it('rechaza una clave de deduplicación abierta', async () => {
		const { service, notificationRepository } = buildService();
		notificationRepository.findOne.mockResolvedValue({ id: 'existing-notification' });

		await expect(
			service.create('holding-1', {
				source: 'salesforce',
				type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
				title: 'Staging bloqueado',
				message: 'Hay registros bloqueados',
				deduplication_key: 'staging:holding-1',
			})
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('reemplaza las suscripciones del tipo Salesforce validando los roles del holding', async () => {
		const { service, dataSource, manager } = buildService();
		dataSource.query.mockResolvedValue([{ id: 'role-1' }]);

		const result = await service.replaceSalesforceStagingBlockedSubscriptions('holding-1', {
			role_ids: ['role-1'],
			include_super_admins: true,
		});

		expect(dataSource.query).toHaveBeenCalledWith('SELECT id FROM public.roles WHERE holding_id = $1 AND id = ANY($2::uuid[])', [
			'holding-1',
			['role-1'],
		]);
		expect(manager.delete).toHaveBeenCalled();
		// 2 destinatarios (rol + super admins) por cada tipo suscribible:
		// staging bloqueado, fallo de sincronización Salesforce y fallo Odoo.
		expect(result).toHaveLength(6);
		expect(result.map((subscription) => subscription.notification_type)).toContain('salesforce_sync_failure');
	});

	it('permite a un Administrador activo del holding configurar suscripciones', async () => {
		const { service, userRepository, dataSource } = buildService();
		userRepository.findOne.mockResolvedValue({
			id: 'user-1',
			role_id: 'role-admin',
			is_super_admin: false,
		});
		dataSource.query.mockResolvedValue([{ role_name: 'Administrador' }]);

		await expect(service.assertCanManageSubscriptions('holding-1', 'auth-user-1')).resolves.toBeUndefined();
		expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('assigned_role.holding_id = $2'), [
			'user-1',
			'holding-1',
			'role-admin',
		]);
	});

	describe('eventos en tiempo real', () => {
		it('emite notification:created a los destinatarios al crear', async () => {
			const { service, roleSubscriptionRepository, notificationsGateway } = buildService();
			roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);

			await service.create('holding-1', {
				source: 'salesforce',
				type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
				title: 'Staging bloqueado',
				message: 'Hay registros bloqueados',
			});

			expect(notificationsGateway.emitNotificationCreated).toHaveBeenCalledWith(
				'holding-1',
				['user-1'],
				expect.objectContaining({ id: 'notification-1' })
			);
		});

		it('emite notification:read al usuario cuando marca como leída una notificación pendiente', async () => {
			const { service, userRepository, recipientQueryBuilder, recipientRepository, notificationsGateway } = buildService();
			userRepository.findOne.mockResolvedValue({ id: 'user-1' });
			recipientQueryBuilder.getOne.mockResolvedValue({
				id: 'recipient-1',
				is_read: false,
				read_at: null,
				notification: { id: 'notification-1' },
			});

			const result = await service.markAsRead('holding-1', 'auth-user-1', 'notification-1');

			expect(recipientRepository.update).toHaveBeenCalledWith('recipient-1', { is_read: true, read_at: expect.any(Date) });
			expect(notificationsGateway.emitNotificationRead).toHaveBeenCalledWith('user-1', {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
				read_at: result.read_at,
			});
			expect(result.is_read).toBe(true);
		});

		it('no actualiza ni emite si la notificación ya estaba leída', async () => {
			const { service, userRepository, recipientQueryBuilder, recipientRepository, notificationsGateway } = buildService();
			const readAt = new Date('2026-09-01T10:00:00Z');
			userRepository.findOne.mockResolvedValue({ id: 'user-1' });
			recipientQueryBuilder.getOne.mockResolvedValue({
				id: 'recipient-1',
				is_read: true,
				read_at: readAt,
				notification: { id: 'notification-1' },
			});

			const result = await service.markAsRead('holding-1', 'auth-user-1', 'notification-1');

			expect(recipientRepository.update).not.toHaveBeenCalled();
			expect(notificationsGateway.emitNotificationRead).not.toHaveBeenCalled();
			expect(result.read_at).toBe(readAt);
		});

		it('emite notification:updated a los destinatarios al actualizar una notificación abierta por deduplicación', async () => {
			const { service, notificationRepository, notificationsGateway } = buildService();
			notificationRepository.findOne.mockResolvedValue({ id: 'notification-1', recipients: [{ user_id: 'user-1' }, { user_id: 'user-2' }] });
			notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });

			const result = await service.createOrUpdate('holding-1', {
				source: 'invoices',
				type: 'invoice_odoo_failure',
				title: 'Falla Odoo',
				message: 'Nuevo intento fallido',
				deduplication_key: 'invoice-odoo-failure:1',
			});

			expect(notificationRepository.update).toHaveBeenCalledWith(
				'notification-1',
				expect.objectContaining({ message: 'Nuevo intento fallido' })
			);
			expect(notificationsGateway.emitNotificationUpdated).toHaveBeenCalledWith(['user-1', 'user-2'], {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
			});
			expect(notificationsGateway.emitNotificationCreated).not.toHaveBeenCalled();
			expect(result.recipient_count).toBe(2);
		});

		it('resuelve por deduplicación y emite notification:updated a los destinatarios', async () => {
			const { service, notificationRepository, notificationsGateway } = buildService();
			notificationRepository.find.mockResolvedValue([{ id: 'notification-1', recipients: [{ user_id: 'user-1' }] }]);

			await service.resolveByDeduplicationKey('holding-1', 'salesforce:sf-1:blocked');

			expect(notificationRepository.update).toHaveBeenCalledWith(
				{ id: expect.anything() },
				{ status: 'resolved', resolved_at: expect.any(Date) }
			);
			expect(notificationsGateway.emitNotificationUpdated).toHaveBeenCalledWith(['user-1'], {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
			});
		});

		it('no actualiza ni emite al resolver si no hay notificaciones abiertas', async () => {
			const { service, notificationRepository, notificationsGateway } = buildService();
			notificationRepository.find.mockResolvedValue([]);

			await service.resolveByDeduplicationKey('holding-1', 'salesforce:sf-1:blocked');

			expect(notificationRepository.update).not.toHaveBeenCalled();
			expect(notificationsGateway.emitNotificationUpdated).not.toHaveBeenCalled();
		});
	});
});

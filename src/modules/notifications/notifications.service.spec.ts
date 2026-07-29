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
		const notificationRepository = { findOne: jest.fn() };
		const recipientRepository = { createQueryBuilder: jest.fn() };
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
		const service = new NotificationsService(
			notificationRepository as any,
			recipientRepository as any,
			roleSubscriptionRepository as any,
			userRepository as any,
			dataSource as any
		);

		return {
			service,
			notificationRepository,
			roleSubscriptionRepository,
			userQueryBuilder,
			dataSource,
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
		expect(manager.insert).toHaveBeenCalledWith(
			expect.anything(),
			[{ notification_id: 'notification-1', user_id: 'user-1' }]
		);
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
		expect(result).toHaveLength(2);
	});
});

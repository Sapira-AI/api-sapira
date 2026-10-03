import { ConflictException, NotFoundException } from '@nestjs/common';

import { NotificationsService, SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE } from './notifications.service';

type Route = (sql: string, params: unknown[]) => unknown;

describe('NotificationsService', () => {
	const buildService = (route: Route = () => undefined) => {
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
		const insertBuilder = {
			insert: jest.fn().mockReturnThis(),
			into: jest.fn().mockReturnThis(),
			values: jest.fn().mockReturnThis(),
			orIgnore: jest.fn().mockReturnThis(),
			execute: jest.fn(),
		};
		const recipientRepository = {
			createQueryBuilder: jest.fn((alias?: string) => (alias ? recipientQueryBuilder : insertBuilder)),
			update: jest.fn(),
		};
		const roleSubscriptionRepository = { find: jest.fn().mockResolvedValue([]) };
		const userRepository = {
			findOne: jest.fn().mockResolvedValue({ id: 'user-1' }),
			createQueryBuilder: jest.fn().mockReturnValue(userQueryBuilder),
		};
		const manager = {
			create: jest.fn((_entity, values) => ({ id: 'notification-1', ...values })),
			save: jest.fn(async (entity) => entity),
			insert: jest.fn(),
			delete: jest.fn(),
		};
		const dataSource = {
			query: jest.fn(async (sql: string, params: unknown[] = []) => {
				const routed = route(sql, params);

				if (routed !== undefined) return routed;
				// Miembros activos del holding: todos los pedidos.
				if (sql.includes('FROM user_holdings')) return (params[1] as string[]).map((user_id) => ({ user_id }));
				if (sql.includes('holding_settings')) return [{ timezone: 'America/Santiago' }];

				return [];
			}),
			transaction: jest.fn(async (callback) => callback(manager)),
		};
		const notificationsGateway = {
			emitNotificationCreated: jest.fn(),
			emitNotificationRead: jest.fn(),
			emitNotificationUpdated: jest.fn(),
		};
		const emails = { queueAlert: jest.fn(async () => 0) };
		const service = new NotificationsService(
			notificationRepository as any,
			recipientRepository as any,
			roleSubscriptionRepository as any,
			userRepository as any,
			dataSource as any,
			notificationsGateway as any,
			emails as any
		);

		return {
			service,
			emails,
			notificationRepository,
			recipientRepository,
			recipientQueryBuilder,
			insertBuilder,
			roleSubscriptionRepository,
			userRepository,
			userQueryBuilder,
			dataSource,
			notificationsGateway,
			manager,
		};
	};
	const sqlCalls = (dataSource: { query: jest.Mock }, fragment: string) =>
		dataSource.query.mock.calls.filter(([sql]) => String(sql).includes(fragment)) as Array<[string, unknown[]]>;
	const staging = {
		source: 'salesforce',
		type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
		title: 'Cotización del CRM detenida',
		message: 'Hay registros bloqueados',
	};

	describe('crear', () => {
		it('crea un evento y destinatarios activos derivados de suscripciones por rol; gravedad por defecto del catálogo', async () => {
			const { service, roleSubscriptionRepository, userQueryBuilder, manager } = buildService();
			roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);

			const result = await service.create('holding-1', staging);

			expect(userQueryBuilder.andWhere).toHaveBeenCalledWith('(user.role_id IN (:...roleIds))');
			expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [{ notification_id: 'notification-1', user_id: 'user-1' }]);
			expect(manager.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ severity: 'error' }));
			expect(result.recipient_count).toBe(1);
		});

		it('quien apagó el tipo en sus preferencias (in_app = false) no queda como destinatario', async () => {
			const { service, roleSubscriptionRepository, userQueryBuilder, manager } = buildService((sql) =>
				sql.includes('FROM user_notification_preferences') ? [{ user_id: 'user-2' }] : undefined
			);
			roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);
			userQueryBuilder.getRawMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]);

			await service.create('holding-1', staging);

			expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [{ notification_id: 'notification-1', user_id: 'user-1' }]);
		});

		it('sin destinatarios no inserta nada (deja log) y no emite', async () => {
			const { service, manager, notificationsGateway } = buildService();

			await expect(service.create('holding-1', staging)).resolves.toEqual({ notification: null, recipient_count: 0 });
			expect(manager.save).not.toHaveBeenCalled();
			expect(notificationsGateway.emitNotificationCreated).not.toHaveBeenCalled();
		});

		it('compañía: la del productor o la derivada del recurso; correo inmediato a los que ven la compañía', async () => {
			const { service, manager, emails, notificationsGateway, userQueryBuilder } = buildService((sql, params) => {
				if (sql.includes('SELECT company_id FROM invoices')) return [{ company_id: 'company-1' }];
				// user-2 filtró "Mis compañías" a otra compañía.
				if (sql.includes('cardinality(company_ids)')) return (params[2] as string[]).includes('user-2') ? [{ user_id: 'user-2' }] : [];
				return undefined;
			});

			userQueryBuilder.getRawMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]);
			await service.create('holding-1', {
				...staging,
				type: 'invoice_odoo_failure',
				resource_type: 'invoice',
				resource_id: '55555555-5555-4555-8555-555555555555',
				recipients: { user_ids: ['user-1', 'user-2'] },
			});

			expect(manager.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ company_id: 'company-1' }));
			expect(notificationsGateway.emitNotificationCreated).toHaveBeenCalledWith('holding-1', ['user-1'], expect.anything());
			expect(emails.queueAlert).toHaveBeenCalledWith(expect.objectContaining({ company_id: 'company-1' }), ['user-1']);

			const explicit = buildService();
			await explicit.service.create('holding-1', { ...staging, company_id: 'company-9', recipients: { user_ids: ['user-1'] } });
			expect(explicit.manager.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ company_id: 'company-9' }));

			const none = buildService();
			await none.service.create('holding-1', { ...staging, recipients: { user_ids: ['user-1'] } });
			expect(none.manager.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ company_id: null }));
			expect(none.emails.queueAlert).toHaveBeenCalledWith(expect.anything(), ['user-1']);
		});

		it('rechaza una clave de deduplicación abierta', async () => {
			const { service, notificationRepository } = buildService();
			notificationRepository.findOne.mockResolvedValue({ id: 'existing-notification' });

			await expect(service.create('holding-1', { ...staging, deduplication_key: 'staging:holding-1' })).rejects.toBeInstanceOf(
				ConflictException
			);
		});

		it('novedad del sistema: a todos los miembros activos de cada holding, con acción al Centro de ayuda', async () => {
			const { service, userQueryBuilder, manager } = buildService();
			const created = await service.notifySystemUpdate({
				slug: 'notificaciones-v2',
				title: 'Nuevo centro',
				message: 'Ya está',
				holdingIds: ['h-1', 'h-2'],
			});

			expect(created).toEqual({ slug: 'notificaciones-v2', holdings: 2, recipients: 2 });
			expect(userQueryBuilder.andWhere).toHaveBeenCalledWith('(true)');
			expect(manager.create).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ type: 'system_update', action_type: 'open_help', action_payload: { slug: 'notificaciones-v2' } })
			);
		});
	});

	describe('createOrUpdate', () => {
		const existing = (extra: Record<string, unknown> = {}) => ({
			id: 'notification-1',
			severity: 'warning',
			metadata: { escalation_step: 30 },
			recipients: [{ user_id: 'user-1' }, { user_id: 'user-2' }],
			...extra,
		});

		it('actualiza el contenido, suma destinatarios nuevos y no toca la lectura si no escala', async () => {
			const {
				service,
				notificationRepository,
				roleSubscriptionRepository,
				userQueryBuilder,
				insertBuilder,
				recipientRepository,
				notificationsGateway,
			} = buildService();
			notificationRepository.findOne.mockResolvedValue(existing());
			notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });
			roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);
			userQueryBuilder.getRawMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-3' }]);

			const result = await service.createOrUpdate('holding-1', {
				source: 'contracts',
				type: 'contract_renewal_reminder',
				severity: 'warning',
				title: 'CTR-1: vence en 30 días',
				message: 'Nuevo texto',
				escalation_step: 30,
				deduplication_key: 'contracts:renewal-reminder:c-1:2026-11-01',
			});

			expect(notificationRepository.update).toHaveBeenCalledWith(
				'notification-1',
				expect.objectContaining({ message: 'Nuevo texto', metadata: { escalation_step: 30 } })
			);
			expect(insertBuilder.values).toHaveBeenCalledWith([{ notification_id: 'notification-1', user_id: 'user-3' }]);
			expect(insertBuilder.orIgnore).toHaveBeenCalled();
			expect(recipientRepository.update).not.toHaveBeenCalled();
			expect(notificationsGateway.emitNotificationCreated).toHaveBeenCalledWith('holding-1', ['user-3'], { id: 'notification-1' });
			expect(notificationsGateway.emitNotificationUpdated).toHaveBeenCalledWith(['user-1', 'user-2'], {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
			});
			expect(result.recipient_count).toBe(3);
		});

		it('si cambia el escalón vuelve a "sin leer" y desarchiva para todos', async () => {
			const { service, notificationRepository, recipientRepository } = buildService();
			notificationRepository.findOne.mockResolvedValue(existing());
			notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });

			await service.createOrUpdate('holding-1', {
				source: 'contracts',
				type: 'contract_renewal_reminder',
				severity: 'warning',
				title: 'CTR-1: vence en 15 días',
				message: 'Escaló',
				escalation_step: 15,
				deduplication_key: 'k',
			});

			expect(recipientRepository.update).toHaveBeenCalledWith(
				{ notification_id: 'notification-1', user_id: expect.anything() },
				{ is_read: false, read_at: null, archived_at: null }
			);
		});

		it('correo: sin escalar solo a los destinatarios nuevos; al escalar a todos (la clave lleva el escalón)', async () => {
			const quiet = buildService();
			quiet.notificationRepository.findOne.mockResolvedValue(existing());
			quiet.notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });
			quiet.userQueryBuilder.getRawMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-3' }]);
			quiet.roleSubscriptionRepository.find.mockResolvedValue([{ role_id: 'role-1' }]);

			await quiet.service.createOrUpdate('holding-1', {
				...staging,
				type: 'contract_renewal_reminder',
				severity: 'warning',
				escalation_step: 30,
				deduplication_key: 'k',
			});
			expect(quiet.emails.queueAlert).toHaveBeenCalledWith({ id: 'notification-1' }, ['user-3'], { escalated: false });

			const loud = buildService();
			loud.notificationRepository.findOne.mockResolvedValue(existing());
			loud.notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });
			loud.userQueryBuilder.getRawMany.mockResolvedValue([]);

			await loud.service.createOrUpdate('holding-1', {
				...staging,
				type: 'contract_renewal_reminder',
				severity: 'warning',
				escalation_step: 15,
				deduplication_key: 'k',
			});
			expect(loud.emails.queueAlert).toHaveBeenCalledWith({ id: 'notification-1' }, ['user-1', 'user-2'], { escalated: true });
		});

		it('si sube la gravedad también vuelve a "sin leer"; si baja, no', async () => {
			const up = buildService();
			up.notificationRepository.findOne.mockResolvedValue(existing({ metadata: {} }));
			up.notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });

			await up.service.createOrUpdate('holding-1', { ...staging, type: 'invoice_odoo_failure', severity: 'error', deduplication_key: 'k' });
			expect(up.recipientRepository.update).toHaveBeenCalled();

			const down = buildService();
			down.notificationRepository.findOne.mockResolvedValue(existing({ severity: 'error', metadata: {} }));
			down.notificationRepository.findOneByOrFail.mockResolvedValue({ id: 'notification-1' });

			await down.service.createOrUpdate('holding-1', { ...staging, type: 'invoice_odoo_failure', severity: 'warning', deduplication_key: 'k' });
			expect(down.recipientRepository.update).not.toHaveBeenCalled();
		});
	});

	describe('cierre automático', () => {
		it('resolveOpen por tipo y recurso: cierra y avisa solo a quienes siguen siendo miembros activos', async () => {
			const { service, notificationRepository, notificationsGateway } = buildService((sql) =>
				sql.includes('FROM user_holdings') ? [{ user_id: 'user-1' }] : undefined
			);
			notificationRepository.find.mockResolvedValue([{ id: 'notification-1', recipients: [{ user_id: 'user-1' }, { user_id: 'ex-member' }] }]);

			await expect(service.resolveOpen('holding-1', { type: 'invoice_odoo_failure', resourceId: 'invoice-1' })).resolves.toBe(1);
			expect(notificationRepository.find).toHaveBeenCalledWith({
				where: { holding_id: 'holding-1', status: 'open', type: 'invoice_odoo_failure', resource_id: 'invoice-1' },
				relations: { recipients: true },
			});
			expect(notificationRepository.update).toHaveBeenCalledWith(
				{ id: expect.anything() },
				{ status: 'resolved', resolved_at: expect.any(Date) }
			);
			expect(notificationsGateway.emitNotificationUpdated).toHaveBeenCalledWith(['user-1'], {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
			});
		});

		it('sin criterios (o con listas vacías) no cierra nada', async () => {
			const { service, notificationRepository } = buildService();

			await expect(service.resolveOpen('holding-1', {})).resolves.toBe(0);
			await expect(service.resolveOpen('holding-1', { ids: [] })).resolves.toBe(0);
			expect(notificationRepository.find).not.toHaveBeenCalled();
		});

		it('resuelve por deduplicación y no emite si no hay abiertas', async () => {
			const { service, notificationRepository, notificationsGateway } = buildService();
			notificationRepository.find.mockResolvedValue([]);

			await service.resolveByDeduplicationKey('holding-1', 'salesforce:sf-1:blocked');

			expect(notificationRepository.update).not.toHaveBeenCalled();
			expect(notificationsGateway.emitNotificationUpdated).not.toHaveBeenCalled();
		});
	});

	describe('bandeja del usuario', () => {
		const row = {
			id: 'notification-1',
			holding_id: 'holding-1',
			type: 'invoice_odoo_failure',
			severity: 'error',
			title: 'No se pudo enviar la factura 12',
			message: 'El ERP la rechazó',
			recommendation: null,
			action_type: 'open_contract',
			action_payload: { contract_id: 'c-1' },
			is_read: false,
			read_at: null,
			archived_at: null,
			total_count: '41',
		};

		it('lista con filtros del holding activo y del usuario, paginación estándar + la forma de siempre', async () => {
			const { service, dataSource } = buildService((sql) =>
				sql.includes('total_count') ? [row] : sql.includes('AS unread') ? [{ unread: '3' }] : undefined
			);

			const result = await service.listForAuthenticatedUser('holding-1', 'auth-1', {
				page: 2,
				limit: 20,
				status: 'open',
				read: false,
				module: ['facturacion'],
				severity: ['error'],
				from: '2026-10-01',
				to: '2026-10-31',
				search: '50%',
			});
			const [sql, params] = sqlCalls(dataSource, 'total_count')[0];

			expect(sql).toContain('r.user_id = $1 AND n.holding_id = $2');
			expect(sql).toContain('r.archived_at IS NULL');
			expect(sql).toContain('n.status = $3');
			expect(sql).toContain('LIMIT 20 OFFSET 20');
			expect(params.slice(0, 4)).toEqual(['user-1', 'holding-1', 'open', false]);
			expect(params).toContainEqual(expect.arrayContaining(['invoice_odoo_failure', 'bigquery_quantities_diff']));
			expect(params).toContain('%50\\%%');
			expect(result).toMatchObject({ total: 41, items: 41, currentPage: 2, pages: 3, limit: 20, unread_count: 3 });
			expect(result.pagination).toEqual({ page: 2, limit: 20, total: 41, total_pages: 3 });
			expect(result.data[0]).toMatchObject({
				label: 'No se pudo enviar una factura al ERP',
				module: 'facturacion',
				module_label: 'Facturación',
				icon: 'receipt-text',
				severity_label: 'Bloquea',
				action: { type: 'open_contract', label: 'Ver contrato', payload: { contract_id: 'c-1' } },
				is_archived: false,
			});
			expect(result.data[0]).not.toHaveProperty('total_count');
		});

		it('archived = true muestra solo las archivadas', async () => {
			const { service, dataSource } = buildService();

			await service.listForAuthenticatedUser('holding-1', 'auth-1', { archived: true });
			expect(sqlCalls(dataSource, 'total_count')[0][0]).toContain('r.archived_at IS NOT NULL');
		});

		it('detalle con "Qué pasó" / "Qué hacer": los del productor y la plantilla del catálogo; ajena → 404', async () => {
			const { service, recipientQueryBuilder } = buildService();
			recipientQueryBuilder.getOne.mockResolvedValueOnce({
				is_read: true,
				read_at: null,
				archived_at: null,
				notification: { ...row, recommendation: null },
			});

			const detail = await service.getForAuthenticatedUser('holding-1', 'auth-1', 'notification-1');

			expect(detail.texts).toEqual({
				what_happened: 'El ERP la rechazó',
				what_to_do: 'Corrige el dato que indica el mensaje en el contrato o en la factura y vuelve a enviarla.',
				what_we_do: 'Reintentamos en la próxima corrida automática y cerramos este aviso cuando la factura se envía bien.',
			});
			recipientQueryBuilder.getOne.mockResolvedValueOnce(null);
			await expect(service.getForAuthenticatedUser('holding-1', 'auth-1', 'otra')).rejects.toBeInstanceOf(NotFoundException);
		});

		it('marcar como leída emite notification:read; si ya estaba leída no hace nada', async () => {
			const { service, recipientQueryBuilder, recipientRepository, notificationsGateway } = buildService();
			recipientQueryBuilder.getOne.mockResolvedValueOnce({ is_read: false, read_at: null, notification: { id: 'notification-1' } });

			const result = await service.markAsRead('holding-1', 'auth-1', 'notification-1');

			expect(recipientRepository.update).toHaveBeenCalledWith(
				{ notification_id: 'notification-1', user_id: 'user-1' },
				{ is_read: true, read_at: expect.any(Date) }
			);
			expect(notificationsGateway.emitNotificationRead).toHaveBeenCalledWith('user-1', {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
				read_at: result.read_at,
			});
			recipientQueryBuilder.getOne.mockResolvedValueOnce({ is_read: true, read_at: new Date(), notification: { id: 'notification-1' } });
			recipientRepository.update.mockClear();
			await service.markAsRead('holding-1', 'auth-1', 'notification-1');
			expect(recipientRepository.update).not.toHaveBeenCalled();
		});

		it('marcar como no leída', async () => {
			const { service, recipientQueryBuilder, recipientRepository } = buildService();
			recipientQueryBuilder.getOne.mockResolvedValueOnce({ is_read: true, read_at: new Date(), notification: { id: 'notification-1' } });

			await expect(service.markAsUnread('holding-1', 'auth-1', 'notification-1')).resolves.toMatchObject({ is_read: false, read_at: null });
			expect(recipientRepository.update).toHaveBeenCalledWith(
				{ notification_id: 'notification-1', user_id: 'user-1' },
				{ is_read: false, read_at: null }
			);
		});

		it('marcar todas respeta los filtros (salvo "leída") y solo las del usuario en el holding', async () => {
			const { service, dataSource } = buildService((sql) => (sql.includes('done AS') ? [{ updated: '4' }] : undefined));

			await expect(service.markAllAsRead('holding-1', 'auth-1', { type: ['invoice_odoo_failure'], read: true })).resolves.toEqual({
				updated: 4,
			});
			const [sql, params] = sqlCalls(dataSource, 'done AS')[0];

			expect(sql).toContain('r.user_id = $1 AND n.holding_id = $2 AND r.is_read = false');
			expect(sql).not.toContain('r.is_read = $');
			expect(params).toEqual(['user-1', 'holding-1', ['invoice_odoo_failure']]);
		});

		it('archivar y desarchivar por usuario', async () => {
			const { service, dataSource } = buildService((sql) => (sql.includes('done AS') ? [{ updated: '2' }] : undefined));

			await expect(service.setArchived('holding-1', 'auth-1', ['n-1', 'n-2'], true)).resolves.toEqual({ updated: 2 });
			expect(sqlCalls(dataSource, 'done AS')[0][0]).toContain('SET archived_at = now()');
			await service.setArchived('holding-1', 'auth-1', ['n-1'], false);
			expect(sqlCalls(dataSource, 'done AS')[1][0]).toContain('SET archived_at = NULL');
			expect(sqlCalls(dataSource, 'done AS')[1][1]).toEqual(['user-1', 'holding-1', ['n-1']]);
		});

		it('conteos sin leer por módulo y por tipo (los heredados van a Sistema)', async () => {
			const { service } = buildService((sql) =>
				sql.includes('GROUP BY n.type')
					? [
							{ type: 'invoice_odoo_failure', unread: '2' },
							{ type: 'contract_renewal_reminder', unread: '1' },
							{ type: 'contract_notifications', unread: '5' },
						]
					: undefined
			);

			const counts = await service.countsForAuthenticatedUser('holding-1', 'auth-1');

			expect(counts.unread).toBe(8);
			expect(counts.by_module.find((item) => item.module === 'facturacion')?.unread).toBe(2);
			expect(counts.by_module.find((item) => item.module === 'contratos')?.unread).toBe(1);
			expect(counts.by_module.find((item) => item.module === 'sistema')?.unread).toBe(5);
		});

		it('usuario autenticado inexistente → 404', async () => {
			const { service, userRepository } = buildService();
			userRepository.findOne.mockResolvedValue(null);

			await expect(service.countsForAuthenticatedUser('holding-1', 'auth-x')).rejects.toThrow('Usuario autenticado no encontrado');
		});
	});

	describe('preferencias', () => {
		it('sin filas: campana encendida, correo apagado y sin resumen semanal; las novedades no son configurables', async () => {
			const { service } = buildService();
			const preferences = await service.getPreferences('holding-1', 'auth-1');

			expect(preferences.weekly_digest).toBe(false);
			expect(preferences.types.find((item) => item.type === 'invoice_odoo_failure')).toMatchObject({ in_app: true, email: false });
			expect(preferences.types.map((item) => item.type)).not.toContain('system_update');
		});

		it('actualiza por tipo (conserva lo no enviado) y el resumen semanal en su fila reservada', async () => {
			const { service, dataSource } = buildService((sql) =>
				sql.includes('SELECT notification_type, in_app, email')
					? [{ notification_type: 'invoice_odoo_failure', in_app: true, email: true }]
					: undefined
			);

			await service.updatePreferences('holding-1', 'auth-1', { types: [{ type: 'invoice_odoo_failure', in_app: false }], weekly_digest: true });
			const upserts = sqlCalls(dataSource, 'INSERT INTO user_notification_preferences');

			expect(upserts.map(([, params]) => params)).toEqual([
				['user-1', 'holding-1', 'invoice_odoo_failure', false, true],
				['user-1', 'holding-1', 'weekly_digest', false, true],
			]);
		});

		it('defaults por rol: Administrador recibe correo de los errores y el resumen semanal; lista sus compañías', async () => {
			const { service } = buildService((sql) => {
				if (sql.includes('FROM users u LEFT JOIN roles')) return [{ is_super_admin: false, role_name: 'Administrador' }];
				if (sql.includes('FROM companies WHERE holding_id')) return [{ id: 'company-1', legal_name: 'Acme SpA', country: 'Chile' }];
				return undefined;
			});
			const preferences = await service.getPreferences('holding-1', 'auth-1');

			expect(preferences.weekly_digest).toBe(true);
			expect(preferences.company_ids).toEqual([]);
			expect(preferences.companies).toEqual([{ id: 'company-1', name: 'Acme SpA', country: 'Chile' }]);
			expect(preferences.types.find((item) => item.type === 'invoice_odoo_failure')).toMatchObject({ email: true });
			expect(preferences.types.find((item) => item.type === 'contract_renewal_proposed')).toMatchObject({ email: false });
			// Los correos internos de Sapira solo los ve un super admin.
			expect(preferences.types.map((item) => item.type)).not.toContain('invoice_fx_fallback');
			expect(preferences.defaults.weekly_digest).toBe(true);
		});

		it('"Mis compañías": guarda la lista en su fila reservada y rechaza compañías de otro holding', async () => {
			const { service, dataSource } = buildService((sql) =>
				sql.includes('FROM companies WHERE holding_id') ? [{ id: '66666666-6666-4666-8666-666666666666', legal_name: 'Acme' }] : undefined
			);

			await service.updatePreferences('holding-1', 'auth-1', { company_ids: ['66666666-6666-4666-8666-666666666666'] });
			const upsert = sqlCalls(dataSource, 'company_ids)')[0];

			expect(upsert[1]).toEqual(['user-1', 'holding-1', 'my_companies', ['66666666-6666-4666-8666-666666666666']]);
			await expect(service.updatePreferences('holding-1', 'auth-1', { company_ids: ['77777777-7777-4777-8777-777777777777'] })).rejects.toThrow(
				'Compañía no válida'
			);
		});

		it('la lista y los conteos filtran por "Mis compañías"', async () => {
			const { service, dataSource } = buildService();

			await service.listForAuthenticatedUser('holding-1', 'auth-1', {});
			await service.countsForAuthenticatedUser('holding-1', 'auth-1');
			const reads = sqlCalls(dataSource, 'FROM app_notification_recipients r');

			expect(reads.length).toBeGreaterThanOrEqual(3);
			for (const [sql] of reads) expect(sql).toContain("mc.notification_type = 'my_companies'");
		});

		it('tipo no válido → 400 con message en español', async () => {
			const { service } = buildService();

			await expect(service.updatePreferences('holding-1', 'auth-1', { types: [{ type: 'system_update', in_app: false }] })).rejects.toThrow(
				'Tipo de aviso no válido: system_update'
			);
		});
	});

	describe('suscripciones por rol', () => {
		it('la ruta vieja reemplaza solo los 3 tipos de siempre validando los roles del holding', async () => {
			const { service, manager } = buildService((sql) => (sql.includes('FROM public.roles') ? [{ id: 'role-1' }] : undefined));

			const result = await service.replaceSalesforceStagingBlockedSubscriptions('holding-1', {
				role_ids: ['role-1'],
				include_super_admins: true,
			});

			expect(manager.delete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ holding_id: 'holding-1' }));
			expect(result).toHaveLength(6);
			expect(new Set(result.map((subscription) => subscription.notification_type))).toEqual(
				new Set(['salesforce_staging_blocked', 'salesforce_sync_failure', 'invoice_odoo_failure'])
			);
		});

		it('permite a un Administrador activo del holding configurar suscripciones', async () => {
			const { service, userRepository, dataSource } = buildService((sql) =>
				sql.includes('assigned_role') ? [{ role_name: 'Administrador' }] : undefined
			);
			userRepository.findOne.mockResolvedValue({ id: 'user-1', role_id: 'role-admin', is_super_admin: false });

			await expect(service.assertCanManageSubscriptions('holding-1', 'auth-user-1')).resolves.toBeUndefined();
			expect(sqlCalls(dataSource, 'assigned_role.holding_id = $2')[0][1]).toEqual(['user-1', 'holding-1', 'role-admin']);
		});

		it('Configuración › Roles: reemplaza solo las del rol entre los tipos ofrecidos e ignora el resto', async () => {
			const { service, manager } = buildService((sql) => (sql.includes('FROM public.roles') ? [{ id: 'role-1' }] : undefined));

			await expect(
				service.replaceRoleSubscriptionTypes('holding-1', 'role-1', [
					'contract_renewal_reminder',
					'otro',
					'invoice_fx_fallback',
					'contract_renewal_reminder',
				])
			).resolves.toEqual(['contract_renewal_reminder']);
			expect(manager.delete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ holding_id: 'holding-1', role_id: 'role-1' }));
			expect(manager.save).toHaveBeenCalledWith([
				expect.objectContaining({ role_id: 'role-1', notification_type: 'contract_renewal_reminder' }),
			]);
		});

		it('rol de otro holding → 404', async () => {
			const { service } = buildService();

			await expect(service.replaceRoleSubscriptionTypes('holding-1', 'role-x', [])).rejects.toThrow('Uno o más roles no pertenecen al holding');
		});
	});
});

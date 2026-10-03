// `TasksController` importa `TasksService` (arrastra el scheduler de facturas, uuid ESM).
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PermissionsService } from '@/guards/permissions.service';
import { SuperAdminOnlyGuard } from '@/guards/super-admin-only.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';
import { TasksController } from '@/modules/tasks/tasks.controller';
import { TasksService } from '@/modules/tasks/tasks.service';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Tenancy (regla `docs/v2-rediseno/autorizacion-y-tenancy.md`): sin header → 400, holding ajeno → 403, registro de otro holding → 404.
 * `HoldingScopeGuard` corre de verdad; `SupabaseAuthGuard` se sobreescribe. También prueba que `GET /notifications/tasks` (otro
 * controlador) no cae en `GET /notifications/:notificationId` aunque `NotificationsController` se registre primero.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION = '33333333-3333-4333-8333-333333333333';

describe('NotificationsController y TasksController (tenancy y rutas)', () => {
	let app: INestApplication;
	const notifications = {
		listForAuthenticatedUser: jest.fn().mockResolvedValue({ data: [] }),
		getForAuthenticatedUser: jest.fn(),
		countsForAuthenticatedUser: jest.fn().mockResolvedValue({ unread: 0 }),
		catalog: jest.fn().mockReturnValue({ modules: [], types: [] }),
		getPreferences: jest.fn(),
		updatePreferences: jest.fn(),
		markAllAsRead: jest.fn().mockResolvedValue({ updated: 0 }),
		setArchived: jest.fn().mockResolvedValue({ updated: 1 }),
		markAsRead: jest.fn(),
		markAsUnread: jest.fn(),
		myCompaniesForAuthUser: jest.fn().mockResolvedValue([]),
		mentionableUsers: jest.fn().mockResolvedValue({ data: [] }),
		notifySystemUpdate: jest.fn().mockResolvedValue({ slug: 'x', holdings: 2, recipients: 5 }),
	};
	const tasks = { pending: jest.fn().mockResolvedValue({ tasks: [] }) };
	const permissions = { isSuperAdmin: jest.fn().mockResolvedValue(false) };

	beforeEach(async () => {
		jest.clearAllMocks();
		const moduleRef = await Test.createTestingModule({
			controllers: [NotificationsController, TasksController],
			providers: [
				{ provide: NotificationsService, useValue: notifications },
				{ provide: TasksService, useValue: tasks },
				HoldingScopeGuard,
				SuperAdminOnlyGuard,
				{ provide: PermissionsService, useValue: permissions },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) },
				},
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
					context.switchToHttp().getRequest().user = { sub: 'auth-1' };
					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
		await request(app.getHttpServer()).get('/notifications').expect(400);
		await request(app.getHttpServer()).get('/notifications/tasks').expect(400);

		expect(notifications.listForAuthenticatedUser).not.toHaveBeenCalled();
		expect(tasks.pending).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403 (cierra #21)', async () => {
		await request(app.getHttpServer()).get('/notifications').set('x-holding-id', OTHER_HOLDING).expect(403);
		await request(app.getHttpServer()).get('/notifications/counts').set('x-holding-id', OTHER_HOLDING).expect(403);

		expect(notifications.listForAuthenticatedUser).not.toHaveBeenCalled();
	});

	it('una notificación de otro holding o de otro usuario responde 404', async () => {
		notifications.getForAuthenticatedUser.mockRejectedValue(new NotFoundException('Notificación no encontrada'));

		const response = await request(app.getHttpServer()).get(`/notifications/${NOTIFICATION}`).set('x-holding-id', HOLDING).expect(404);

		expect(response.body.message).toBe('Notificación no encontrada');
		expect(notifications.getForAuthenticatedUser).toHaveBeenCalledWith(HOLDING, 'auth-1', NOTIFICATION);
	});

	it('/notifications/tasks llega a Tareas (no al detalle) y /notifications/<no-uuid> no existe', async () => {
		await request(app.getHttpServer()).get('/notifications/tasks?as_of=2026-10-03').set('x-holding-id', HOLDING).expect(200);

		expect(tasks.pending).toHaveBeenCalledWith(HOLDING, '2026-10-03', []);
		expect(notifications.getForAuthenticatedUser).not.toHaveBeenCalled();
		await request(app.getHttpServer()).get('/notifications/otra-cosa').set('x-holding-id', HOLDING).expect(404);
	});

	it('filtros de la lista: listas separadas por coma, booleanos y validación en español', async () => {
		await request(app.getHttpServer())
			.get('/notifications?module=facturacion,contratos&read=false&severity=error&page=2')
			.set('x-holding-id', HOLDING)
			.expect(200);

		expect(notifications.listForAuthenticatedUser).toHaveBeenCalledWith(
			HOLDING,
			'auth-1',
			expect.objectContaining({ module: ['facturacion', 'contratos'], read: false, severity: ['error'], page: 2 })
		);
		const bad = await request(app.getHttpServer()).get('/notifications?module=otro').set('x-holding-id', HOLDING).expect(400);

		expect(JSON.stringify(bad.body.message)).toContain('Módulo inválido');
	});

	it('archivar exige ids válidos; marcar todas pasa los filtros del cuerpo', async () => {
		await request(app.getHttpServer()).post('/notifications/archive').set('x-holding-id', HOLDING).send({ ids: [] }).expect(400);
		await request(app.getHttpServer())
			.post('/notifications/archive')
			.set('x-holding-id', HOLDING)
			.send({ ids: [NOTIFICATION] })
			.expect(200);
		expect(notifications.setArchived).toHaveBeenCalledWith(HOLDING, 'auth-1', [NOTIFICATION], true);

		await request(app.getHttpServer())
			.post('/notifications/read-all')
			.set('x-holding-id', HOLDING)
			.send({ type: ['invoice_odoo_failure'] })
			.expect(200);
		expect(notifications.markAllAsRead).toHaveBeenCalledWith(HOLDING, 'auth-1', expect.objectContaining({ type: ['invoice_odoo_failure'] }));
	});

	it('marcar leída / no leída por id', async () => {
		await request(app.getHttpServer()).patch(`/notifications/${NOTIFICATION}/unread`).set('x-holding-id', HOLDING).expect(200);
		expect(notifications.markAsUnread).toHaveBeenCalledWith(HOLDING, 'auth-1', NOTIFICATION);
		await request(app.getHttpServer()).patch(`/notifications/${NOTIFICATION}/read`).set('x-holding-id', HOLDING).expect(200);
		expect(notifications.markAsRead).toHaveBeenCalledWith(HOLDING, 'auth-1', NOTIFICATION);
	});

	it('tareas: "Mis compañías" por defecto, company_ids explícitos o all=true', async () => {
		const company = '44444444-4444-4444-8444-444444444444';

		notifications.myCompaniesForAuthUser.mockResolvedValueOnce([company]);
		await request(app.getHttpServer()).get('/notifications/tasks').set('x-holding-id', HOLDING).expect(200);
		expect(tasks.pending).toHaveBeenLastCalledWith(HOLDING, undefined, [company]);

		await request(app.getHttpServer())
			.get(`/notifications/tasks?company_ids=${company},${NOTIFICATION}`)
			.set('x-holding-id', HOLDING)
			.expect(200);
		expect(tasks.pending).toHaveBeenLastCalledWith(HOLDING, undefined, [company, NOTIFICATION]);

		await request(app.getHttpServer()).get('/notifications/tasks?all=true').set('x-holding-id', HOLDING).expect(200);
		expect(tasks.pending).toHaveBeenLastCalledWith(HOLDING, undefined, []);
		await request(app.getHttpServer()).get('/notifications/tasks?company_ids=no-uuid').set('x-holding-id', HOLDING).expect(400);
	});

	it('novedades del sistema: solo super admin y validadas', async () => {
		const body = { slug: 'notificaciones-v2', title: 'Nuevo centro', summary: 'Tareas y alertas en un solo lugar' };

		await request(app.getHttpServer()).post('/notifications/system-updates').set('x-holding-id', HOLDING).send(body).expect(403);
		expect(notifications.notifySystemUpdate).not.toHaveBeenCalled();

		permissions.isSuperAdmin.mockResolvedValue(true);
		await request(app.getHttpServer())
			.post('/notifications/system-updates')
			.set('x-holding-id', HOLDING)
			.send({ ...body, slug: 'Con Espacios' })
			.expect(400);
		const response = await request(app.getHttpServer()).post('/notifications/system-updates').set('x-holding-id', HOLDING).send(body).expect(200);

		expect(response.body).toEqual({ slug: 'x', holdings: 2, recipients: 5 });
		expect(notifications.notifySystemUpdate).toHaveBeenCalledWith({
			slug: 'notificaciones-v2',
			title: 'Nuevo centro',
			message: 'Tareas y alertas en un solo lugar',
		});
		permissions.isSuperAdmin.mockResolvedValue(false);
	});

	it('usuarios mencionables del holding activo', async () => {
		await request(app.getHttpServer()).get('/notifications/mentionable-users?search=dom&limit=5').set('x-holding-id', HOLDING).expect(200);
		expect(notifications.mentionableUsers).toHaveBeenCalledWith(HOLDING, 'dom', 5);
	});
});

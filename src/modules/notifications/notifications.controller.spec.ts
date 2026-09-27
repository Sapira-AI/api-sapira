import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Los tres casos de la regla de tenancy: sin header → 400, holding ajeno → 403, registro ajeno → 404. */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

describe('NotificationsController (tenancy)', () => {
	let app: INestApplication;
	const notifications = {
		listForAuthenticatedUser: jest.fn(),
		getForAuthenticatedUser: jest.fn(),
		markAsRead: jest.fn(),
		assertCanManageSubscriptions: jest.fn(),
		listSalesforceStagingBlockedSubscriptions: jest.fn(),
		replaceSalesforceStagingBlockedSubscriptions: jest.fn(),
	};

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [NotificationsController],
			providers: [
				{ provide: NotificationsService, useValue: notifications },
				HoldingScopeGuard,
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) },
				},
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
					context.switchToHttp().getRequest().user = { sub: 'auth-1', id: 'auth-1' };
					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
		await request(app.getHttpServer()).get('/notifications').expect(400);

		expect(notifications.listForAuthenticatedUser).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403', async () => {
		await request(app.getHttpServer()).get('/notifications').set('x-holding-id', OTHER_HOLDING).expect(403);

		expect(notifications.listForAuthenticatedUser).not.toHaveBeenCalled();
	});

	it('con una notificación de otro holding responde 404', async () => {
		notifications.getForAuthenticatedUser.mockRejectedValue(new NotFoundException('Notificación no encontrada'));

		await request(app.getHttpServer()).get(`/notifications/${NOTIFICATION}`).set('x-holding-id', HOLDING).expect(404);

		expect(notifications.getForAuthenticatedUser).toHaveBeenCalledWith(HOLDING, 'auth-1', NOTIFICATION);
	});

	it('entrega al servicio el holding validado del header', async () => {
		notifications.listForAuthenticatedUser.mockResolvedValue({ data: [] });

		await request(app.getHttpServer()).get('/notifications').set('x-holding-id', HOLDING).expect(200);

		expect(notifications.listForAuthenticatedUser).toHaveBeenCalledWith(HOLDING, 'auth-1', expect.anything());
	});

	it('rechaza con 403 si la query trae un holding_id distinto al del header', async () => {
		await request(app.getHttpServer()).get(`/notifications?holding_id=${OTHER_HOLDING}`).set('x-holding-id', HOLDING).expect(403);

		expect(notifications.listForAuthenticatedUser).not.toHaveBeenCalled();
	});
});

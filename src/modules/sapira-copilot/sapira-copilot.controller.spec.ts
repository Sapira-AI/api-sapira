import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { SapiraCopilotController } from './sapira-copilot.controller';
import { SapiraCopilotService } from './sapira-copilot.service';

/** Los tres casos de la regla de tenancy: sin header → 400, holding ajeno → 403, registro ajeno → 404. */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const SESSION = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';

describe('SapiraCopilotController (tenancy)', () => {
	let app: INestApplication;
	const copilot = {
		sendMessage: jest.fn(),
		createSession: jest.fn(),
		listSessions: jest.fn(),
		getSessionById: jest.fn(),
		updateSession: jest.fn(),
		deleteSession: jest.fn(),
	};

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [SapiraCopilotController],
			providers: [
				{ provide: SapiraCopilotService, useValue: copilot },
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
					context.switchToHttp().getRequest().user = { sub: 'auth-1' };
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
		await request(app.getHttpServer()).get('/sapira-copilot/sessions').expect(400);

		expect(copilot.listSessions).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403', async () => {
		await request(app.getHttpServer()).get('/sapira-copilot/sessions').set('x-holding-id', OTHER_HOLDING).expect(403);

		expect(copilot.listSessions).not.toHaveBeenCalled();
	});

	it('con una sesión de otro holding responde 404', async () => {
		copilot.getSessionById.mockRejectedValue(new NotFoundException('Sesión no encontrada'));

		await request(app.getHttpServer()).get(`/sapira-copilot/sessions/${SESSION}`).set('x-holding-id', HOLDING).expect(404);

		expect(copilot.getSessionById).toHaveBeenCalledWith(SESSION, HOLDING);
	});

	it('el chat usa el holding del header y ya no el del body', async () => {
		copilot.sendMessage.mockResolvedValue({ answer: 'ok' });

		await request(app.getHttpServer()).post('/sapira-copilot/chat').set('x-holding-id', HOLDING).send({ message: 'hola' }).expect(200);

		expect(copilot.sendMessage).toHaveBeenCalledWith('hola', HOLDING, expect.anything());
	});

	it('acepta el holding_id deprecado del front viejo cuando coincide con el header', async () => {
		copilot.sendMessage.mockResolvedValue({ answer: 'ok' });

		await request(app.getHttpServer())
			.post('/sapira-copilot/chat')
			.set('x-holding-id', HOLDING)
			.send({ message: 'hola', holding_id: HOLDING })
			.expect(200);

		expect(copilot.sendMessage).toHaveBeenCalledWith('hola', HOLDING, expect.anything());
	});

	it('rechaza con 403 un holding_id en el body distinto al del header', async () => {
		await request(app.getHttpServer())
			.post('/sapira-copilot/chat')
			.set('x-holding-id', HOLDING)
			.send({ message: 'hola', holding_id: OTHER_HOLDING })
			.expect(403);

		expect(copilot.sendMessage).not.toHaveBeenCalled();
	});

	it('rechaza con 403 un holding_id en la query distinto al del header', async () => {
		await request(app.getHttpServer()).get(`/sapira-copilot/sessions?holding_id=${OTHER_HOLDING}`).set('x-holding-id', HOLDING).expect(403);

		expect(copilot.listSessions).not.toHaveBeenCalled();
	});
});

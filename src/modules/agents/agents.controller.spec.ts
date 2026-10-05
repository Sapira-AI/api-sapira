import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Los tres casos de la regla de tenancy: sin header → 400, holding ajeno → 403, registro ajeno → 404.
 *
 * Antes de esto el controlador tomaba el holding del body, de la query o de `user.holding_id`, sin validar
 * pertenencia: cualquier sesión podía operar sobre los agentes de otro holding.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('AgentsController (tenancy)', () => {
	let app: INestApplication;
	const agents = {
		runAgent: jest.fn(),
		approveRun: jest.fn(),
		getHoldingConfig: jest.fn(),
		listClientConfigs: jest.fn(),
		updateAgentConfig: jest.fn(),
		listEmailSenders: jest.fn(),
	};

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [AgentsController],
			providers: [
				{ provide: AgentsService, useValue: agents },
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
		await request(app.getHttpServer()).post(`/agents/${AGENT}/run`).send({ mode: 'preview' }).expect(400);

		expect(agents.runAgent).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403', async () => {
		await request(app.getHttpServer()).post(`/agents/${AGENT}/run`).set('x-holding-id', OTHER_HOLDING).send({ mode: 'preview' }).expect(403);

		expect(agents.runAgent).not.toHaveBeenCalled();
	});

	it('con un agente de otro holding responde 404', async () => {
		agents.runAgent.mockRejectedValue(new NotFoundException('Agente no encontrado'));

		await request(app.getHttpServer()).post(`/agents/${AGENT}/run`).set('x-holding-id', HOLDING).send({ mode: 'preview' }).expect(404);

		expect(agents.runAgent).toHaveBeenCalledWith(AGENT, 'preview', HOLDING);
	});

	it('entrega al servicio el holding del header, no el del body', async () => {
		agents.runAgent.mockResolvedValue({ runId: 'run-1' });

		await request(app.getHttpServer()).post(`/agents/${AGENT}/run`).set('x-holding-id', HOLDING).send({ mode: 'execute' }).expect(200);

		expect(agents.runAgent).toHaveBeenCalledWith(AGENT, 'execute', HOLDING);
	});

	it('acepta el holding_id deprecado del front actual cuando coincide con el header', async () => {
		agents.runAgent.mockResolvedValue({ runId: 'run-1' });

		await request(app.getHttpServer())
			.post(`/agents/${AGENT}/run`)
			.set('x-holding-id', HOLDING)
			.send({ mode: 'preview', holding_id: HOLDING })
			.expect(200);

		expect(agents.runAgent).toHaveBeenCalledWith(AGENT, 'preview', HOLDING);
	});

	it('rechaza con 403 un holding_id en el body distinto al del header', async () => {
		await request(app.getHttpServer())
			.post(`/agents/${AGENT}/run`)
			.set('x-holding-id', HOLDING)
			.send({ mode: 'preview', holding_id: OTHER_HOLDING })
			.expect(403);

		expect(agents.runAgent).not.toHaveBeenCalled();
	});

	it('las consultas de configuración también toman el holding del header', async () => {
		agents.getHoldingConfig.mockResolvedValue({});

		await request(app.getHttpServer()).get('/agents/holding-config?agent_type=proforma').set('x-holding-id', HOLDING).expect(200);

		expect(agents.getHoldingConfig).toHaveBeenCalledWith(HOLDING, 'proforma');
	});

	it('rechaza con 403 un holding_id en la query distinto al del header', async () => {
		await request(app.getHttpServer()).get(`/agents/client-configs?holding_id=${OTHER_HOLDING}`).set('x-holding-id', HOLDING).expect(403);

		expect(agents.listClientConfigs).not.toHaveBeenCalled();
	});
});

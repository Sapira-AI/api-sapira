import { ConflictException, INestApplication, NotFoundException, ValidationError, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors, validationException } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PermissionsService } from '@/guards/permissions.service';
import { RequirePermissionGuard } from '@/guards/require-permission.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * Tenancy (sin header → 400, holding ajeno → 403, registro ajeno → 404) y permisos: leer exige VIEW_AGENTES_IA; ejecutar,
 * aprobar, descartar y configurar exigen EDIT_AGENTES_IA ("Editar incluye Ver").
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const RUN = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CLIENT = 'c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const USERS: Record<string, { codes: string[]; super?: boolean }> = {
	nobody: { codes: [] },
	reader: { codes: ['VIEW_AGENTES_IA'] },
	editor: { codes: ['EDIT_AGENTES_IA'] },
	all: { codes: ['ALL_PERMISSIONS'] },
	super: { codes: [], super: true },
};

describe('AgentsController', () => {
	let app: INestApplication;
	const agents = {
		runAgent: jest.fn(),
		approveRun: jest.fn(),
		cancelRun: jest.fn(),
		getHoldingConfig: jest.fn(),
		updateHoldingConfig: jest.fn(),
		getClientConfig: jest.fn(),
		updateClientConfig: jest.fn(),
		deleteClientConfig: jest.fn(),
		listClientConfigs: jest.fn(),
		clientConfigsSummary: jest.fn(),
		updateAgentConfig: jest.fn(),
		listEmailSenders: jest.fn(),
		listAgents: jest.fn(),
		listRuns: jest.fn(),
		getRunDetail: jest.fn(),
		listRunMessages: jest.fn(),
	};
	const dataSource = {
		query: jest.fn(async (_sql: string, params: unknown[] = []) => {
			const user = USERS[String(params[0])];

			if (!user || params[1] !== HOLDING) return [];

			return [
				{ id: `user-${params[0]}`, name: 'x', email: 'x@x.cl', is_super_admin: user.super === true, role_id: 'role-1', codes: user.codes },
			];
		}),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [AgentsController],
			providers: [
				{ provide: AgentsService, useValue: agents },
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: DataSource, useValue: dataSource },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) },
				},
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => { headers: Record<string, string>; user?: unknown } } }) => {
					const req = context.switchToHttp().getRequest();

					req.user = { sub: req.headers['x-test-user'] ?? 'editor' };

					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				forbidNonWhitelisted: true,
				transform: true,
				exceptionFactory: (errors: ValidationError[]) => {
					throw validationException(flattenValidationErrors(errors));
				},
			})
		);
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => jest.clearAllMocks());

	const get = (path: string, user = 'reader', holding: string | null = HOLDING) => {
		const req = request(app.getHttpServer()).get(path).set('x-test-user', user);

		return holding ? req.set('x-holding-id', holding) : req;
	};
	const send = (method: 'post' | 'put' | 'delete', path: string, body: object = {}, user = 'editor', holding = HOLDING) =>
		request(app.getHttpServer())[method](path).set('x-test-user', user).set('x-holding-id', holding).send(body);

	describe('tenancy', () => {
		it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
			await request(app.getHttpServer()).post(`/agents/${AGENT}/run`).set('x-test-user', 'editor').send({ mode: 'preview' }).expect(400);

			expect(agents.runAgent).not.toHaveBeenCalled();
		});

		it('con un holding al que el usuario no pertenece responde 403', async () => {
			await send('post', `/agents/${AGENT}/run`, { mode: 'preview' }, 'editor', OTHER_HOLDING).expect(403);

			expect(agents.runAgent).not.toHaveBeenCalled();
		});

		it('con un agente de otro holding responde 404', async () => {
			agents.runAgent.mockRejectedValueOnce(new NotFoundException('Agente no encontrado'));

			await send('post', `/agents/${AGENT}/run`, { mode: 'preview' }).expect(404);

			expect(agents.runAgent).toHaveBeenCalledWith(AGENT, 'preview', HOLDING);
		});

		it('una ejecución de otro holding responde 404', async () => {
			agents.getRunDetail.mockRejectedValueOnce(new NotFoundException('Ejecución no encontrada'));

			await get(`/agents/runs/${RUN}`).expect(404);

			expect(agents.getRunDetail).toHaveBeenCalledWith(RUN, HOLDING);
		});

		it('acepta el holding_id deprecado del front actual cuando coincide con el header', async () => {
			agents.runAgent.mockResolvedValueOnce({ run_id: 'run-1' });

			await send('post', `/agents/${AGENT}/run`, { mode: 'preview', holding_id: HOLDING }).expect(200);

			expect(agents.runAgent).toHaveBeenCalledWith(AGENT, 'preview', HOLDING);
		});

		it('rechaza con 403 un holding_id en el body o la query distinto al del header', async () => {
			await send('post', `/agents/${AGENT}/run`, { mode: 'preview', holding_id: OTHER_HOLDING }).expect(403);
			await get(`/agents/client-configs?holding_id=${OTHER_HOLDING}`).expect(403);

			expect(agents.runAgent).not.toHaveBeenCalled();
			expect(agents.listClientConfigs).not.toHaveBeenCalled();
		});

		it('las consultas de configuración toman el holding del header', async () => {
			agents.getHoldingConfig.mockResolvedValueOnce({});

			await get('/agents/holding-config?agent_type=proforma').expect(200);

			expect(agents.getHoldingConfig).toHaveBeenCalledWith(HOLDING, 'proforma');
		});
	});

	describe('permisos', () => {
		it('sin VIEW_AGENTES_IA no lee (403 con el mensaje de permisos)', async () => {
			const res = await get('/agents', 'nobody').expect(403);

			expect(res.body.message).toBe('No tienes permiso para ver las automatizaciones · pídeselo a un administrador');
			expect(agents.listAgents).not.toHaveBeenCalled();
		});

		it('VIEW lee pero no ejecuta, aprueba, descarta ni configura', async () => {
			agents.listAgents.mockResolvedValue([]);
			await get('/agents', 'reader').expect(200);

			const res = await send('post', `/agents/${AGENT}/run`, { mode: 'execute' }, 'reader').expect(403);

			expect(res.body.message).toBe('No tienes permiso para configurar y ejecutar las automatizaciones · pídeselo a un administrador');
			await send('post', `/agents/runs/${RUN}/approve`, {}, 'reader').expect(403);
			await send('post', `/agents/runs/${RUN}/cancel`, {}, 'reader').expect(403);
			await send('post', '/agents/holding-config', { agent_type: 'proforma', is_enabled: true, config_json: {} }, 'reader').expect(403);
			await send(
				'post',
				'/agents/client-config',
				{ client_id: CLIENT, agent_type: 'proforma', is_enabled: true, config_json: {} },
				'reader'
			).expect(403);
			await send('put', `/agents/${AGENT}/config`, { auto_execute: true }, 'reader').expect(403);
			await send('delete', `/agents/client-configs/${CLIENT}/proforma`, {}, 'reader').expect(403);

			expect(agents.runAgent).not.toHaveBeenCalled();
			expect(agents.approveRun).not.toHaveBeenCalled();
			expect(agents.cancelRun).not.toHaveBeenCalled();
		});

		it('EDIT (incluye VIEW), ALL_PERMISSIONS y super admin ejecutan', async () => {
			agents.runAgent.mockResolvedValue({ run_id: 'run-1' });
			agents.listAgents.mockResolvedValue([]);

			await get('/agents', 'editor').expect(200);
			await send('post', `/agents/${AGENT}/run`, { mode: 'execute' }, 'editor').expect(200);
			await send('post', `/agents/${AGENT}/run`, { mode: 'execute' }, 'all').expect(200);
			await send('post', `/agents/${AGENT}/run`, { mode: 'execute' }, 'super').expect(200);
		});
	});

	describe('ejecuciones', () => {
		it('lista con filtros y paginación validados', async () => {
			agents.listRuns.mockResolvedValueOnce({ data: [], total: 0, currentPage: 2, pages: 1, limit: 10 });

			const res = await get('/agents/runs?page=2&limit=10&type=collections&status=queued').expect(200);

			expect(res.body.data).toEqual({ data: [], total: 0, currentPage: 2, pages: 1, limit: 10 });
			expect(agents.listRuns).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({ page: 2, limit: 10, type: 'collections', status: 'queued' })
			);
		});

		it('rechaza filtros inválidos con 400', async () => {
			await get('/agents/runs?status=foo').expect(400);
			await get('/agents/runs?limit=500').expect(400);

			expect(agents.listRuns).not.toHaveBeenCalled();
		});

		it('aprobar entrega al servicio quién aprueba', async () => {
			agents.approveRun.mockResolvedValueOnce({ run_id: RUN, status: 'sent' });

			await send('post', `/agents/runs/${RUN}/approve`).expect(200);

			expect(agents.approveRun).toHaveBeenCalledWith(RUN, HOLDING, 'user-editor');
		});

		it('descartar responde 409 si la ejecución no está pendiente', async () => {
			agents.cancelRun.mockRejectedValueOnce(new ConflictException('Solo se puede descartar una ejecución pendiente de aprobación'));

			await send('post', `/agents/runs/${RUN}/cancel`).expect(409);

			expect(agents.cancelRun).toHaveBeenCalledWith(RUN, HOLDING, 'user-editor');
		});

		it('un id de ejecución que no es UUID responde 400', async () => {
			await get('/agents/runs/no-es-uuid').expect(400);

			expect(agents.getRunDetail).not.toHaveBeenCalled();
		});

		it('mensajes de una ejecución', async () => {
			agents.listRunMessages.mockResolvedValueOnce([{ id: 'm1' }]);

			const res = await get(`/agents/runs/${RUN}/messages`).expect(200);

			expect(res.body.data).toEqual([{ id: 'm1' }]);
			expect(agents.listRunMessages).toHaveBeenCalledWith(RUN, HOLDING);
		});
	});

	describe('configuración por cliente', () => {
		it('volver a la global borra la fila propia (204)', async () => {
			agents.deleteClientConfig.mockResolvedValueOnce(undefined);

			await send('delete', `/agents/client-configs/${CLIENT}/collections`).expect(204);

			expect(agents.deleteClientConfig).toHaveBeenCalledWith(CLIENT, 'collections', HOLDING);
		});

		it('rechaza un tipo de agente desconocido', async () => {
			await send('delete', `/agents/client-configs/${CLIENT}/deal_validation`).expect(400);

			expect(agents.deleteClientConfig).not.toHaveBeenCalled();
		});

		it('resumen por tipo', async () => {
			agents.clientConfigsSummary.mockResolvedValueOnce({
				proforma: { total: 1, enabled: 1 },
				collections: { total: 0, enabled: 0 },
				client_ids: [CLIENT],
			});

			const res = await get('/agents/client-configs/summary').expect(200);

			expect(res.body.data.client_ids).toEqual([CLIENT]);
			expect(agents.clientConfigsSummary).toHaveBeenCalledWith(HOLDING);
		});
	});
});

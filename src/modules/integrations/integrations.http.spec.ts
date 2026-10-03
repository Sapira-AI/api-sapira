// Los adaptadores importan módulos que usan `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ForbiddenException, INestApplication, NotFoundException, RequestMethod, ValidationError, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors, validationException } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PermissionsService } from '@/guards/permissions.service';
import { REQUIRED_PERMISSIONS_KEY, RequirePermissionGuard } from '@/guards/require-permission.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

const USERS: Record<string, { codes: string[]; super?: boolean }> = {
	nobody: { codes: [] },
	reader: { codes: ['VIEW_INTEGRACIONES'] },
	editor: { codes: ['EDIT_INTEGRACIONES'] },
	settings: { codes: ['VIEW_CONFIGURACION', 'EDIT_CONFIGURACION'] },
	all: { codes: ['ALL_PERMISSIONS'] },
	super: { codes: [], super: true },
};

const fn = (value: unknown = { ok: true }) => jest.fn(async () => value);
const adapterMock = () => ({
	getConnection: fn({ connected: true, secrets: { api_key: { has_secret: true, secret_last4: '4F2A' } } }),
	testConnection: fn({ ok: true }),
	setActive: fn(),
	sync: fn({ run_id: 'erp-send:1', status: 'running' }),
	listRuns: fn({ data: [], total: 0, currentPage: 1, pages: 1, limit: 20 }),
	getRun: fn(),
	saveConnection: fn(),
	listConnections: fn({ data: [] }),
	getConnectionById: fn(),
	taxes: fn(),
	stages: fn(),
	importOpportunities: fn(),
});

describe('Integraciones · HTTP (tenancy, permisos, validación)', () => {
	let app: INestApplication;
	const erp = adapterMock();
	const crm = adapterMock();
	const stripe = adapterMock();
	const datos = adapterMock();
	const byTipo: Record<string, ReturnType<typeof adapterMock>> = { erp, crm, stripe, datos };
	const service = {
		erp,
		crm,
		stripe,
		datos,
		adapter: jest.fn((tipo: string) => {
			if (!byTipo[tipo]) throw new NotFoundException('Integración no encontrada');

			return byTipo[tipo];
		}),
		actorOf: jest.fn((authId: string) => ({ authId, userId: 'user-1' })),
		summary: fn({ data: [] }),
		records: fn(),
		importRecords: fn(),
		discard: fn({ updated: 1 }),
		restore: fn({ updated: 1 }),
		getSettings: fn(),
		putSettings: fn(),
		ruleFields: fn(),
		getRules: fn(),
		putRules: fn(),
		getMapping: fn(),
		mappingOptions: fn(),
		putMapping: fn(),
		deleteMapping: fn(undefined),
		acceptSuggestions: fn(),
		deleteConnection: fn(undefined),
		fetchCrmOpportunities: fn(),
		assertFieldsEditor: jest.fn(async () => undefined),
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
			controllers: [IntegrationsController],
			providers: [
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: DataSource, useValue: dataSource },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_auth: string, holdingId: string) => holdingId === HOLDING) },
				},
				{ provide: IntegrationsService, useValue: service },
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
	const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, body: object = {}, user = 'editor', holding = HOLDING) =>
		request(app.getHttpServer())[method](path).set('x-test-user', user).set('x-holding-id', holding).send(body);

	describe('tenancy', () => {
		it('sin header x-holding-id → 400 y no llega al servicio', async () => {
			await get('/integrations', 'reader', null).expect(400);
			expect(service.summary).not.toHaveBeenCalled();
		});

		it('holding ajeno → 403', async () => {
			const res = await get('/integrations', 'reader', OTHER_HOLDING).expect(403);

			expect(res.body.message).toBe('No tienes acceso a este holding');
		});

		it('registro de otro holding → 404 del servicio', async () => {
			stripe.getConnectionById.mockRejectedValueOnce(new NotFoundException('Cuenta de Stripe no encontrada'));
			const res = await get(`/integrations/stripe/connections/${ACCOUNT}`).expect(404);

			expect(res.body.message).toBe('Cuenta de Stripe no encontrada');
		});

		it('tipo desconocido → 404', async () => {
			await get('/integrations/odoo/runs').expect(404);
		});
	});

	describe('permisos', () => {
		it('sin VIEW_INTEGRACIONES → 403 con el mensaje de permisos', async () => {
			const res = await get('/integrations', 'nobody').expect(403);

			expect(res.body.message).toBe('No tienes permiso para ver las integraciones · pídeselo a un administrador');
			await get('/integrations', 'settings').expect(403);
		});

		it('VIEW lee pero no cambia; EDIT (incluye VIEW), ALL_PERMISSIONS y super admin cambian', async () => {
			await get('/integrations/erp/connection', 'reader').expect(200);
			const res = await send('post', '/integrations/erp/sync', {}, 'reader').expect(403);

			expect(res.body.message).toBe('No tienes permiso para configurar las integraciones · pídeselo a un administrador');
			await get('/integrations/erp/connection', 'editor').expect(200);
			await send('post', '/integrations/erp/sync', {}, 'editor').expect(202);
			await send('post', '/integrations/crm/sync', {}, 'all').expect(202);
			await send('post', '/integrations/datos/sync', {}, 'super').expect(202);
		});

		it('mapeo de campos: cambiarlo pasa por el control de super admin / Admin Técnico', async () => {
			service.assertFieldsEditor.mockRejectedValueOnce(
				new ForbiddenException('Solo un super admin o el Administrador técnico pueden cambiar el mapeo de campos')
			);
			await send('put', '/integrations/erp/mappings/fields', { items: [{ sapira_id: 'a:b:c', external_id: 'name' }] }).expect(403);
			expect(service.putMapping).not.toHaveBeenCalled();
			await send('put', '/integrations/erp/mappings/products', { items: [{ sapira_id: 'p', external_id: '1' }] }).expect(200);
			expect(service.assertFieldsEditor).toHaveBeenCalledTimes(1);
		});
	});

	describe('rutas y validación', () => {
		it('Stripe va por cuentas: la conexión singular responde 404', async () => {
			await get('/integrations/stripe/connection').expect(404);
			await get('/integrations/stripe/connections').expect(200);
			expect(stripe.listConnections).toHaveBeenCalledWith(HOLDING);
		});

		it('PUT de conexión rechaza campos desconocidos y valida la URL', async () => {
			const res = await send('put', '/integrations/erp/connection', {
				name: 'Odoo',
				url: 'no-es-url',
				database_name: 'db',
				username: 'u',
				extra: 1,
			}).expect(400);

			expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(['extra', 'url']);
		});

		it('holding_id en el body distinto al header → 403', async () => {
			await send('post', '/integrations/crm/records/discard', { object: 'opportunity', ids: ['006A'], holding_id: OTHER_HOLDING }).expect(403);
		});

		it('records: status en lista y búsqueda acotada', async () => {
			await get('/integrations/crm/records?status=error,ready&page=2&limit=10').expect(200);
			expect(service.records).toHaveBeenCalledWith(HOLDING, 'crm', expect.objectContaining({ status: ['error', 'ready'], page: 2, limit: 10 }));
			await get('/integrations/crm/records?status=raro').expect(400);
		});

		it('traer oportunidades sin body (último mes) y con ids inválidos', async () => {
			await send('post', '/integrations/crm/opportunities/fetch').expect(200);
			expect(service.fetchCrmOpportunities).toHaveBeenCalledWith(HOLDING, {});
			await send('post', '/integrations/crm/opportunities/fetch', { opportunity_ids: ['x'] }).expect(400);
		});

		it('borrar con confirm=true pasa el confirm al servicio', async () => {
			await send('delete', '/integrations/erp/connection?confirm=true').expect(204);
			expect(service.deleteConnection).toHaveBeenCalledWith(HOLDING, 'erp', true);
		});

		it('reglas: operador inválido → 400', async () => {
			await send('put', '/integrations/crm/rules', {
				rules: [{ name: 'R', object: 'opportunity', conditions: [{ field: 'Type', operator: 'mayor' }] }],
			}).expect(400);
		});
	});

	it('guards en orden y toda escritura con EDIT_INTEGRACIONES', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, IntegrationsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard]);
		expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, IntegrationsController)).toEqual(['VIEW_INTEGRACIONES']);
		for (const name of Object.getOwnPropertyNames(IntegrationsController.prototype)) {
			const handler = (IntegrationsController.prototype as unknown as Record<string, object>)[name];
			const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;

			if (method === undefined || method === RequestMethod.GET) continue;
			expect({ name, codes: Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) }).toEqual({ name, codes: ['EDIT_INTEGRACIONES'] });
		}
	});
});

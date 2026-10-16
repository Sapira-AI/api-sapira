import { INestApplication, NotFoundException, ValidationError, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors, validationException } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PermissionsService } from '@/guards/permissions.service';
import { RequirePermissionGuard } from '@/guards/require-permission.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { encodeLineKey } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const KEY = encodeLineKey({ client_id: '44444444-4444-4444-8444-444444444444', product_name: 'PATHFINDER+', contract_currency: 'USD' });

const USERS: Record<string, { codes: string[]; super?: boolean }> = {
	nobody: { codes: [] },
	reader: { codes: ['VIEW_CONFIGURACION'] },
	editor: { codes: ['EDIT_CONFIGURACION'] },
	super: { codes: [], super: true },
};
const fn = (value: unknown = { ok: true }) => jest.fn(async () => value);

describe('Onboarding · HTTP (tenancy, permisos, validación)', () => {
	let app: INestApplication;
	const onboarding = { summary: fn(), events: fn() };
	const history = {
		list: fn(),
		detail: fn(),
		editMonths: fn(),
		link: fn(),
		unlink: fn(),
		close: fn(),
		remove: fn(),
		reopen: fn(),
		contractDefaults: fn(),
		contractPreview: fn(),
		createContract: fn(),
	};
	const previousInvoices = {
		list: fn(),
		batches: fn([]),
		previewImport: fn(),
		applyImport: fn(),
		revertImport: fn(),
		detail: fn(),
		assignClient: fn(),
	};
	const register = { preview: fn(), register: fn() };
	const quickStart = { preview: fn(), apply: fn() };
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
			controllers: [OnboardingController],
			providers: [
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: DataSource, useValue: dataSource },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_auth: string, holdingId: string) => holdingId === HOLDING) },
				},
				{ provide: OnboardingService, useValue: onboarding },
				{ provide: OnboardingHistoryService, useValue: history },
				{ provide: OnboardingPreviousInvoicesService, useValue: previousInvoices },
				{ provide: OnboardingRegisterService, useValue: register },
				{ provide: OnboardingQuickStartService, useValue: quickStart },
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
	const send = (method: 'post' | 'patch', path: string, body: object = {}, user = 'editor', holding = HOLDING) =>
		request(app.getHttpServer())[method](path).set('x-test-user', user).set('x-holding-id', holding).send(body);

	describe('tenancy (HoldingScopeGuard)', () => {
		it('sin header x-holding-id → 400 y no llega al servicio', async () => {
			await get('/onboarding/summary', 'reader', null).expect(400);
			expect(onboarding.summary).not.toHaveBeenCalled();
		});

		it('holding ajeno → 403', async () => {
			const res = await get('/onboarding/history/lines', 'reader', OTHER_HOLDING).expect(403);

			expect(res.body.message).toBe('No tienes acceso a este holding');
			expect(history.list).not.toHaveBeenCalled();
		});

		it('registro de otro holding → 404 del servicio (el servicio siempre acota por el holding del header)', async () => {
			previousInvoices.detail.mockRejectedValueOnce(new NotFoundException('Factura previa no encontrada'));
			const res = await get(`/onboarding/previous-invoices/${INVOICE}`).expect(404);

			expect(res.body.message).toBe('Factura previa no encontrada');
			expect(previousInvoices.detail).toHaveBeenCalledWith(HOLDING, INVOICE);
			history.detail.mockRejectedValueOnce(new NotFoundException('Línea de MRR histórico no encontrada'));
			await get(`/onboarding/history/lines/${KEY}`).expect(404);
		});
	});

	describe('permisos (Administración)', () => {
		it('sin VIEW_CONFIGURACION → 403 con el mensaje de permisos', async () => {
			const res = await get('/onboarding/summary', 'nobody').expect(403);

			expect(res.body.message).toBe('No tienes permiso para ver la administración · pídeselo a un administrador');
		});

		it('VIEW lee pero no escribe; EDIT (incluye VIEW) y super admin escriben', async () => {
			await get('/onboarding/previous-invoices/batches', 'reader').expect(200);
			const res = await send('post', `/onboarding/history/lines/${KEY}/close`, {}, 'reader').expect(403);

			expect(res.body.message).toBe('No tienes permiso para editar la administración · pídeselo a un administrador');
			await get('/onboarding/summary', 'editor').expect(200);
			await send('post', `/onboarding/history/lines/${KEY}/close`, {}, 'editor').expect(200);
			await send('post', `/onboarding/history/lines/${KEY}/reopen`, {}, 'super').expect(200);
			expect(history.close).toHaveBeenCalledWith(HOLDING, KEY, {}, { authId: 'editor', userId: 'user-editor' });
		});
	});

	describe('rutas y validación', () => {
		it('las rutas fijas de facturas previas no caen en :id', async () => {
			await get('/onboarding/previous-invoices/batches').expect(200);
			expect(previousInvoices.batches).toHaveBeenCalled();
			expect(previousInvoices.detail).not.toHaveBeenCalled();
		});

		it('quitar exige motivo duplicate | error; empalmar exige contrato', async () => {
			const res = await send('post', `/onboarding/history/lines/${KEY}/remove`, { reason: 'churn' }).expect(400);

			expect(res.body.errors[0]).toMatchObject({ field: 'reason' });
			await send('post', `/onboarding/history/lines/${KEY}/link`, {}).expect(400);
			expect(history.remove).not.toHaveBeenCalled();
		});

		it('importación: rechaza campos desconocidos y create_entities con cliente nuevo por nombre (nunca crea clientes)', async () => {
			const row = {
				row: 1,
				invoice_number: 'F-1',
				issue_date: '2026-07-01',
				legal_client_name: 'Acme',
				company_name: 'Simplit SpA',
				currency: 'brl',
				amount: 1,
				total: 1,
				items: [{ subtotal: 1 }],
				client_crm_id: '001X',
			};

			await send('post', '/onboarding/previous-invoices/import/preview', { invoices: [row] }).expect(200);
			expect(previousInvoices.previewImport).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({ invoices: [expect.objectContaining({ currency: 'BRL' })] })
			);
			const res = await send('post', '/onboarding/previous-invoices/import', {
				invoices: [row],
				create_entities: [{ legal_name: 'Acme', country: 'BR', client: { name: 'Nuevo' } }],
			}).expect(400);

			expect(res.body.message).toContain('client');
			expect(previousInvoices.applyImport).not.toHaveBeenCalled();
		});

		it('registrar histórico y arranque rápido validan meses y productos', async () => {
			await send('post', '/onboarding/previous-invoices/register-history/preview', {
				invoices: [
					{
						invoice_id: INVOICE,
						period_from: '2026-13',
						period_to: '2026-07',
						contract_currency: 'USD',
						amount_contract_currency: 1,
						products: [],
					},
				],
			}).expect(400);
			await send('post', '/onboarding/quick-start/preview', { as_of: '2026-07', history_months: 30 }).expect(400);
			await send('post', '/onboarding/quick-start', {
				as_of: '2026-07',
				proposals: [
					{
						entity_id: INVOICE,
						period_from: '2026-07',
						period_to: '2026-07',
						contract_currency: 'brl',
						amount_contract_currency: 10,
						products: [],
					},
				],
			}).expect(201);
			expect(quickStart.apply).toHaveBeenCalled();
		});
	});
});

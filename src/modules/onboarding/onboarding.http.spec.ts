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

import { OnboardingAdoptService } from './onboarding-adopt.service';
import { encodeLineKey } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';
import { OnboardingSeriesService } from './onboarding-series.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const KEY = encodeLineKey({
	batch_id: '55555555-5555-4555-8555-555555555555',
	client_id: '44444444-4444-4444-8444-444444444444',
	contract_currency: 'USD',
	contract_id: null,
});
const OTHER_KEY = encodeLineKey({
	batch_id: '66666666-6666-4666-8666-666666666666',
	client_id: '44444444-4444-4444-8444-444444444444',
	contract_currency: 'USD',
	contract_id: null,
});

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
		editPreview: fn(),
		editLine: fn(),
		link: fn(),
		unlink: fn(),
		close: fn(),
		reopen: fn(),
		unify: fn(),
		contractDefaults: fn(),
		contractPreview: fn(),
		createContract: fn(),
	};
	const previousInvoices = {
		list: fn(),
		batches: fn([]),
		filterOptions: fn({ companies: [], countries: [] }),
		previewImport: fn(),
		applyImport: fn(),
		revertImport: fn(),
		detail: fn(),
		assignClient: fn(),
	};
	const register = { preview: fn(), register: fn() };
	const adopt = { preview: fn({ can_apply: false }), apply: fn({ applied: true }) };
	const quickStart = { preview: fn(), apply: fn() };
	const series = { series: fn(), filterOptions: fn({ companies: [], countries: [], currencies: { contract: [], invoice: [] } }) };
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
				{ provide: OnboardingSeriesService, useValue: series },
				{ provide: OnboardingAdoptService, useValue: adopt },
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
			await send('post', `/onboarding/history/lines/${KEY}/close`, { notes: 'nota' }, 'editor').expect(200);
			await send('post', `/onboarding/history/lines/${KEY}/reopen`, {}, 'super').expect(200);
			expect(history.close).toHaveBeenCalledWith(HOLDING, KEY, { notes: 'nota' }, { authId: 'editor', userId: 'user-editor' });
		});
	});

	describe('rutas y validación', () => {
		it('las rutas fijas de facturas previas no caen en :id', async () => {
			await get('/onboarding/previous-invoices/batches').expect(200);
			expect(previousInvoices.batches).toHaveBeenCalled();
			expect(previousInvoices.detail).not.toHaveBeenCalled();
		});

		it('"Quitar" ya no existe (404); no activar solo acepta notes; relacionar exige contrato', async () => {
			await send('post', `/onboarding/history/lines/${KEY}/remove`, { reason: 'duplicate' }).expect(404);
			const res = await send('post', `/onboarding/history/lines/${KEY}/close`, { reason: 'x' }).expect(400);

			expect(res.body.message).toContain('reason');
			await send('post', `/onboarding/history/lines/${KEY}/link`, {}).expect(400);
			expect(history.close).not.toHaveBeenCalled();
		});

		it('unificar: ruta fija antes de :key, 2 a 50 claves, solo EDIT', async () => {
			await send('post', '/onboarding/history/lines/unify', { keys: [KEY] }).expect(400);
			await send('post', '/onboarding/history/lines/unify', { keys: [KEY, OTHER_KEY] }, 'reader').expect(403);
			await send('post', '/onboarding/history/lines/unify', { keys: [KEY, OTHER_KEY] }).expect(200);
			expect(history.unify).toHaveBeenCalledWith(HOLDING, { keys: [KEY, OTHER_KEY] }, { authId: 'editor', userId: 'user-editor' });
			expect(history.detail).not.toHaveBeenCalled();
		});

		it('crear contrato desde el registro acepta products[] (nombres) y origin.record_key', async () => {
			const body = {
				client_id: '44444444-4444-4444-8444-444444444444',
				client_entity_id: INVOICE,
				company_id: INVOICE,
				contract_currency: 'USD',
				items: [
					{
						product_id: INVOICE,
						item_type: 'Fijo',
						quantity: 1,
						unit_price: 10,
						billing_frequency: 'Mensual',
						billing_method: 'Anticipado',
						start_date: '2026-07-01',
						term_months: 12,
					},
				],
				products: ['PATHFINDER+'],
				origin: { type: 'history', record_key: KEY },
			};

			await send('post', `/onboarding/history/lines/${KEY}/contract/preview`, body).expect(200);
			expect(history.contractPreview).toHaveBeenCalledWith(HOLDING, KEY, expect.objectContaining({ products: ['PATHFINDER+'] }));
			await send('post', `/onboarding/history/lines/${KEY}/contract/preview`, { ...body, products: [] }).expect(400);
			await send('post', `/onboarding/history/lines/${KEY}/contract/preview`, { ...body, origin: { type: 'history', line_key: KEY } }).expect(
				400
			);
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

		it('editar línea = volver a registrar sus facturas: vista previa y PATCH validan el registro por factura; solo EDIT escribe', async () => {
			const body = {
				invoices: [
					{
						invoice_id: INVOICE,
						period_from: '2026-04',
						period_to: '2026-06',
						contract_currency: 'usd',
						amount_contract_currency: 300,
						is_recurring: true,
						products: [{ product_id: INVOICE, amount_contract_currency: 300 }],
					},
				],
			};

			await send('post', `/onboarding/history/lines/${KEY}/edit/preview`, body).expect(200);
			expect(history.editPreview).toHaveBeenCalledWith(
				HOLDING,
				KEY,
				expect.objectContaining({ invoices: [expect.objectContaining({ contract_currency: 'USD' })] })
			);
			await send('patch', `/onboarding/history/lines/${KEY}`, body).expect(200);
			expect(history.editLine).toHaveBeenCalledWith(HOLDING, KEY, expect.objectContaining({ invoices: expect.any(Array) }), {
				authId: 'editor',
				userId: 'user-editor',
			});
			const res = await send('patch', `/onboarding/history/lines/${KEY}`, {
				invoices: [{ ...body.invoices[0], period_from: '2026-13' }],
			}).expect(400);

			expect(res.body.errors[0]).toMatchObject({ field: 'invoices.0.period_from' });
			// El contrato anterior (meses sueltos) ya no existe.
			await send('patch', `/onboarding/history/lines/${KEY}`, { months: [] }).expect(400);
			await send('patch', `/onboarding/history/lines/${KEY}`, { invoices: [] }).expect(400);
			await send('patch', `/onboarding/history/lines/${KEY}`, body, 'reader').expect(403);
			expect(history.editLine).toHaveBeenCalledTimes(1);
		});

		it('tres estados: removed y pending_ended ya no son estados (400); ended ya no es filtro (400); contractId y batchId sí', async () => {
			await get('/onboarding/history/lines?status=pending_ended').expect(400);
			await get('/onboarding/history/lines?status=removed').expect(400);
			await get('/onboarding/history/lines?ended=true').expect(400);
			await get(`/onboarding/history/lines?status=pending,closed&contractId=${INVOICE}&batchId=${INVOICE}&product=PF`).expect(200);
			expect(history.list).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({ status: 'pending,closed', contractId: INVOICE, batchId: INVOICE, product: 'PF' })
			);
			await get('/onboarding/history/lines?contractId=x').expect(400);
		});

		it('registrar histórico acepta target_key por factura y global (continuar un registro)', async () => {
			const invoice = {
				invoice_id: INVOICE,
				period_from: '2026-07',
				period_to: '2026-07',
				contract_currency: 'USD',
				amount_contract_currency: 1,
				products: [{ product_id: INVOICE, amount_contract_currency: 1 }],
			};

			await send('post', '/onboarding/previous-invoices/register-history/preview', {
				invoices: [{ ...invoice, target_key: KEY }],
				target_key: OTHER_KEY,
			}).expect(200);
			expect(register.preview).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({ target_key: OTHER_KEY, invoices: [expect.objectContaining({ target_key: KEY })] })
			);
			await send('post', '/onboarding/previous-invoices/register-history', { invoices: [invoice], target_key: 'x'.repeat(201) }).expect(400);
		});

		it('serie del MRR histórico: lectura VIEW_CONFIGURACION; valida moneda, meses, uuids y país', async () => {
			await get('/onboarding/history/series', 'nobody').expect(403);
			await get('/onboarding/history/series', 'reader', null).expect(400);
			await get('/onboarding/history/series', 'reader', OTHER_HOLDING).expect(403);
			expect(series.series).not.toHaveBeenCalled();
			await get(
				`/onboarding/history/series?currency=invoice&companyId=${INVOICE}&entityId=${INVOICE}&country=cl&from=2025-01&to=2026-09`
			).expect(200);
			expect(series.series).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({ currency: 'invoice', companyId: INVOICE, entityId: INVOICE, country: 'CL', from: '2025-01', to: '2026-09' })
			);
			await get('/onboarding/history/series?currency=company').expect(400);
			// Concepto (Domi 18-10): solo linked | not_activated | pending.
			await get('/onboarding/history/series?groupBy=client&concept=pending').expect(200);
			expect(series.series).toHaveBeenLastCalledWith(HOLDING, expect.objectContaining({ groupBy: 'client', concept: 'pending' }));
			await get('/onboarding/history/series?concept=counted').expect(400);
			await get('/onboarding/history/series?from=2025-13').expect(400);
			await get('/onboarding/history/series?clientId=acme').expect(400);
			await get('/onboarding/history/series?country=Chile').expect(400);
			await get('/onboarding/history/filter-options').expect(200);
			expect(series.filterOptions).toHaveBeenCalledWith(HOLDING);
		});

		it('editar meses sueltos se retiró (18-10): PATCH …/:key/months ya no existe', async () => {
			await send('patch', `/onboarding/history/lines/${KEY}/months`, { months: [{ id: INVOICE, subtotal_contract_currency: 1 }] }).expect(404);
			expect(history.editLine).not.toHaveBeenCalled();
		});

		it('facturas previas: filter-options no cae en :id; hasHistory, companyId y country se validan', async () => {
			await get('/onboarding/previous-invoices/filter-options').expect(200);
			expect(previousInvoices.filterOptions).toHaveBeenCalledWith(HOLDING);
			expect(previousInvoices.detail).not.toHaveBeenCalled();
			await get(`/onboarding/previous-invoices?hasHistory=false&companyId=${INVOICE}&country=br`).expect(200);
			expect(previousInvoices.list).toHaveBeenCalledWith(HOLDING, expect.objectContaining({ hasHistory: 'false', country: 'BR' }));
			await get('/onboarding/previous-invoices?hasHistory=si').expect(400);
			await get('/onboarding/previous-invoices?country=Brasil').expect(400);
		});

		it('importación con histórico en el mismo paso: acepta los campos nuevos de factura e ítem y valida sus formatos', async () => {
			const row = {
				row: 1,
				invoice_number: 'F-1',
				issue_date: '2026-07-01',
				legal_client_name: 'Acme',
				company_name: 'Simplit SpA',
				currency: 'BRL',
				amount: 1,
				total: 1,
				client_number: 'C-1',
				country: 'br',
				notes: 'nota',
				items: [
					{
						subtotal: 1,
						product: 'PF',
						period_from: '2026-07',
						period_to: '2026-07',
						contract_currency: 'usd',
						amount_contract_currency: 1,
						is_recurring: true,
					},
				],
			};

			await send('post', '/onboarding/previous-invoices/import/preview', { invoices: [row] }).expect(200);
			expect(previousInvoices.previewImport).toHaveBeenCalledWith(
				HOLDING,
				expect.objectContaining({
					invoices: [expect.objectContaining({ country: 'BR', items: [expect.objectContaining({ contract_currency: 'USD' })] })],
				})
			);
			const res = await send('post', '/onboarding/previous-invoices/import/preview', {
				invoices: [{ ...row, items: [{ ...row.items[0], period_from: '2026-7' }] }],
			}).expect(400);

			expect(res.body.errors[0]).toMatchObject({ field: 'invoices.0.items.0.period_from' });
		});

		it('adoptar como factura del contrato: vista previa y aplicar exigen EDIT, validan uuids y meses, y no caen en :id', async () => {
			await send('post', '/onboarding/previous-invoices/adopt/preview', { invoices: [{ invoice_id: INVOICE }] }, 'reader').expect(403);
			await send('post', '/onboarding/previous-invoices/adopt/preview', { invoices: [{ invoice_id: INVOICE, months: ['2026-13'] }] }).expect(
				400
			);
			await send('post', '/onboarding/previous-invoices/adopt/preview', { invoices: [] }).expect(400);
			await send('post', '/onboarding/previous-invoices/adopt/preview', {
				contract_id: INVOICE,
				invoices: [{ invoice_id: INVOICE, months: ['2026-04', '2026-05'], keep_remainder: true }],
			}).expect(200);
			expect(adopt.preview).toHaveBeenCalledWith(HOLDING, {
				contract_id: INVOICE,
				invoices: [{ invoice_id: INVOICE, months: ['2026-04', '2026-05'], keep_remainder: true }],
			});
			// Aplicar: contrato obligatorio; notas ≤ 500.
			await send('post', '/onboarding/previous-invoices/adopt', { invoices: [{ invoice_id: INVOICE }] }).expect(400);
			await send('post', '/onboarding/previous-invoices/adopt', {
				contract_id: INVOICE,
				invoices: [{ invoice_id: INVOICE }],
				notes: 'x'.repeat(501),
			}).expect(400);
			await send(
				'post',
				'/onboarding/previous-invoices/adopt',
				{ contract_id: INVOICE, invoices: [{ invoice_id: INVOICE }], notes: 'ok' },
				'editor'
			).expect(201);
			expect(adopt.apply).toHaveBeenCalledWith(
				HOLDING,
				{ contract_id: INVOICE, invoices: [{ invoice_id: INVOICE }], notes: 'ok' },
				{ authId: 'editor', userId: 'user-editor' }
			);
			expect(previousInvoices.detail).not.toHaveBeenCalled();
			expect(previousInvoices.assignClient).not.toHaveBeenCalled();
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
			// Lo completado por la usuaria (opcional) se valida con el mismo DTO que al aplicar.
			const nested = await send('post', '/onboarding/quick-start/preview', {
				as_of: '2026-07',
				proposals: [
					{
						entity_id: INVOICE,
						period_from: '2026-7',
						period_to: '2026-07',
						contract_currency: 'BRL',
						amount_contract_currency: 1,
						products: [],
					},
				],
			}).expect(400);

			expect(nested.body.errors[0]).toMatchObject({ field: 'proposals.0.period_from' });
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

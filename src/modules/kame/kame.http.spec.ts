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

import { KameConnectionsService } from './kame-connections.service';
import { KameExportService } from './kame-export.service';
import { KameController } from './kame.controller';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const FOREIGN_COMPANY = '44444444-4444-4444-8444-444444444444';

const USERS: Record<string, string[]> = { nobody: [], reader: ['VIEW_INTEGRACIONES'], editor: ['EDIT_INTEGRACIONES'] };

describe('Integraciones › ERP › Kame · HTTP (tenancy, permisos, secretos)', () => {
	let app: INestApplication;
	const view = {
		environment: 'pruebas',
		client_id: 'abc',
		has_secret: true,
		secret_last4: '1234',
		user_email: 'x@y.cl',
		kame_company_rut: '10491356-3',
	};
	const ownCompany = (companyId: string) => {
		if (companyId !== COMPANY) throw new NotFoundException('Compañía no encontrada');
	};
	const connections = {
		overview: jest.fn(async () => ({ auto_enabled: false, job_enabled: false, allowed_ruts: [], data: [] })),
		setAuto: jest.fn(async (_h: string, enabled: boolean) => ({ auto_enabled: enabled, job_enabled: false })),
		saveConnection: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), view)),
		testConnection: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), { ok: true })),
		deleteConnection: jest.fn(async (_h: string, companyId: string) => ownCompany(companyId)),
		updateSettings: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), { enabled: true })),
		switchEnvironment: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), { active_environment: 'produccion' })),
	};
	const exportsService = {
		list: jest.fn(async () => ({ data: [], total: 0, currentPage: 1, pages: 1, limit: 25 })),
		exportById: jest.fn(async () => ({ id: 'e' })),
		sendNow: jest.fn(async () => ({ processed: 0 })),
		retry: jest.fn(async () => ({ processed: 1 })),
		previewJournal: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), { ok: true })),
		sendJournalNow: jest.fn(async (_h: string, companyId: string) => (ownCompany(companyId), { status: 'sent' })),
	};
	const dataSource = {
		query: jest.fn(async (_sql: string, params: unknown[] = []) => {
			const codes = USERS[String(params[0])];

			if (!codes || params[1] !== HOLDING) return [];

			return [{ id: `user-${params[0]}`, name: 'x', email: 'x@x.cl', is_super_admin: false, role_id: 'role-1', codes }];
		}),
	};
	const api = (method: 'get' | 'put' | 'post' | 'patch' | 'delete', path: string, user = 'editor', holding: string | null = HOLDING) => {
		const req = request(app.getHttpServer())[method](`/integrations/erp/kame${path}`).set('x-test-user', user);

		return holding ? req.set('x-holding-id', holding) : req;
	};
	const body = { client_id: 'abc', client_secret: 'secreto-1234', user_email: 'conta@empresa.cl', kame_company_rut: '10.491.356-3' };

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [KameController],
			providers: [
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: DataSource, useValue: dataSource },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_a: string, holdingId: string) => holdingId === HOLDING) },
				},
				{ provide: KameConnectionsService, useValue: connections },
				{ provide: KameExportService, useValue: exportsService },
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

	afterAll(() => app.close());

	it('sin x-holding-id → 400; holding ajeno → 403; compañía de otro holding → 404', async () => {
		await api('get', '/companies', 'editor', null).expect(400);
		await api('get', '/companies', 'editor', OTHER_HOLDING).expect(403);
		await api('put', `/companies/${FOREIGN_COMPANY}/connections/pruebas`).send(body).expect(404);
		await api('get', `/companies/${FOREIGN_COMPANY}/journal/2026-09`).expect(404);
	});

	it('leer con VIEW_INTEGRACIONES; cambiar exige EDIT_INTEGRACIONES', async () => {
		await api('get', '/companies', 'nobody').expect(403);
		await api('get', '/companies', 'reader').expect(200);
		await api('get', '/exports', 'reader').expect(200);
		await api('put', `/companies/${COMPANY}/connections/pruebas`, 'reader').send(body).expect(403);
		await api('put', '/auto', 'reader').send({ enabled: true }).expect(403);
		await api('post', '/exports/send-now', 'reader').send({}).expect(403);
		await api('put', '/auto', 'editor').send({ enabled: true }).expect(200, { auto_enabled: true, job_enabled: false });
	});

	it('la conexión devuelve solo los últimos 4 del secret; el body no acepta holding_id ni un ambiente inventado', async () => {
		const res = await api('put', `/companies/${COMPANY}/connections/pruebas`).send(body).expect(200);

		expect(res.body).toMatchObject({ has_secret: true, secret_last4: '1234' });
		expect(JSON.stringify(res.body)).not.toContain('secreto');
		await api('put', `/companies/${COMPANY}/connections/pruebas`)
			.send({ ...body, holding_id: HOLDING })
			.expect(400);
		await api('put', `/companies/${COMPANY}/connections/sandbox`).send(body).expect(400);
		await api('put', `/companies/${COMPANY}/connections/pruebas`)
			.send({ ...body, user_email: 'no-es-correo' })
			.expect(400);
	});

	it('interruptores, ambiente y asientos validan su forma', async () => {
		await api('patch', `/companies/${COMPANY}/settings`).send({ enabled: true, dry_run: false }).expect(200);
		await api('patch', `/companies/${COMPANY}/settings`).send({ journal_from: '2026-9' }).expect(400);
		await api('post', `/companies/${COMPANY}/environment`).send({ environment: 'produccion', invoices_from: '2026-10-20' }).expect(200);
		await api('post', `/companies/${COMPANY}/journal/2026-13x/send`).expect(400);
		await api('post', `/companies/${COMPANY}/journal/2026-09/send`).expect(200);
		await api('post', '/exports/retry').send({ ids: [] }).expect(400);
		await api('post', '/exports/retry')
			.send({ ids: [COMPANY] })
			.expect(200);
		expect(exportsService.retry).toHaveBeenCalledWith(HOLDING, [COMPANY], 'user-editor');
	});
});

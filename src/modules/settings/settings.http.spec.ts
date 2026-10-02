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
import { ProductsController } from '@/modules/products/products.controller';
import { ProductsService } from '@/modules/products/products.service';

import { AccountingPeriodsService } from './accounting-periods.service';
import { CompanyLegalDocumentsService } from './company-legal-documents.service';
import { CountriesController } from './countries.controller';
import { SettingsAccessController } from './settings-access.controller';
import { SettingsCatalogsController } from './settings-catalogs.controller';
import { SettingsCatalogsService } from './settings-catalogs.service';
import { SettingsCompaniesController } from './settings-companies.controller';
import { SettingsCompaniesService } from './settings-companies.service';
import { SettingsCustomFieldsController } from './settings-custom-fields.controller';
import { SettingsCustomFieldsService } from './settings-custom-fields.service';
import { SettingsHoldingController } from './settings-holding.controller';
import { SettingsHoldingService } from './settings-holding.service';
import { SettingsRolesService } from './settings-roles.service';
import { SettingsUsersService } from './settings-users.service';

/**
 * Configuración y Productos por HTTP con los guards reales (`HoldingScopeGuard`, `RequirePermissionGuard` + `PermissionsService`) y los
 * servicios mockeados: tenancy (400/403/404), permisos por rol (403, `ALL_PERMISSIONS`, super admin, rol de otro holding) y validación
 * de DTOs (400, campos desconocidos). El usuario de la sesión se elige con el header de prueba `x-test-user`.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

const USERS: Record<string, { codes: string[]; super?: boolean; roleInHolding?: boolean }> = {
	nobody: { codes: [] },
	reader: { codes: ['VIEW_CONFIGURACION'] },
	editor: { codes: ['VIEW_CONFIGURACION', 'EDIT_CONFIGURACION'] },
	closer: { codes: ['VIEW_CONFIGURACION', 'CLOSE_PERIODS'] },
	all: { codes: ['ALL_PERMISSIONS'] },
	super: { codes: [], super: true },
	contracts_reader: { codes: ['VIEW_CONTRATOS'] },
	contracts_editor: { codes: ['VIEW_CONTRATOS', 'EDIT_CONTRATOS'] },
	// Su users.role_id es de otro holding: el join con roles.holding_id no lo encuentra.
	foreign_role: { codes: ['ALL_PERMISSIONS'], roleInHolding: false },
};

/** Servicio con todos sus métodos como `jest.fn` que resuelven `{ ok: true }`. */
function autoMock() {
	const target: Record<string, jest.Mock> = {};

	return new Proxy(target, {
		// `then` y los símbolos quedan indefinidos: Nest trata como promesa a un provider con `then`.
		get: (object, key: string | symbol) =>
			typeof key === 'symbol' || key === 'then' ? undefined : (object[key] ??= jest.fn(async () => ({ ok: true }))),
	});
}

describe('Configuración · HTTP (tenancy, permisos, validación)', () => {
	let app: INestApplication;
	const services = {
		holding: autoMock(),
		catalogs: autoMock(),
		fields: autoMock(),
		companies: autoMock(),
		documents: autoMock(),
		periods: autoMock(),
		users: autoMock(),
		roles: autoMock(),
		products: autoMock(),
	};
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			if (sql.includes('FROM countries')) return [{ code: 'CL', name_es: 'Chile', name_en: 'Chile' }];
			const user = USERS[String(params[0])];

			if (!user || params[1] !== HOLDING) return [];

			return [
				{
					id: `user-${params[0]}`,
					name: String(params[0]),
					email: `${params[0]}@x.cl`,
					is_super_admin: user.super === true,
					role_id: user.roleInHolding === false ? null : 'role-1',
					codes: user.roleInHolding === false ? [] : user.codes,
				},
			];
		}),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [
				SettingsHoldingController,
				SettingsCatalogsController,
				SettingsCustomFieldsController,
				SettingsCompaniesController,
				SettingsAccessController,
				CountriesController,
				ProductsController,
			],
			providers: [
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: DataSource, useValue: dataSource },
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_auth: string, holdingId: string) => holdingId === HOLDING) },
				},
				{ provide: SettingsHoldingService, useValue: services.holding },
				{ provide: SettingsCatalogsService, useValue: services.catalogs },
				{ provide: SettingsCustomFieldsService, useValue: services.fields },
				{ provide: SettingsCompaniesService, useValue: services.companies },
				{ provide: CompanyLegalDocumentsService, useValue: services.documents },
				{ provide: AccountingPeriodsService, useValue: services.periods },
				{ provide: SettingsUsersService, useValue: services.users },
				{ provide: SettingsRolesService, useValue: services.roles },
				{ provide: ProductsService, useValue: services.products },
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

	const get = (path: string, user = 'editor', holding: string | null = HOLDING) => {
		const req = request(app.getHttpServer()).get(path).set('x-test-user', user);

		return holding ? req.set('x-holding-id', holding) : req;
	};
	const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}, user = 'editor', holding = HOLDING) =>
		request(app.getHttpServer())[method](path).set('x-test-user', user).set('x-holding-id', holding).send(body);

	describe('tenancy', () => {
		it('sin header x-holding-id → 400 y no llega al servicio', async () => {
			await get('/settings/holding', 'editor', null).expect(400);
			await get('/products', 'contracts_reader', null).expect(400);
			expect(services.holding.getHolding).not.toHaveBeenCalled();
		});

		it('holding al que no pertenece → 403', async () => {
			const res = await get('/settings/companies', 'editor', OTHER_HOLDING).expect(403);

			expect(res.body.message).toBe('No tienes acceso a este holding');
		});

		it('holding_id en el body distinto al header → 403', async () => {
			await send('post', '/settings/sellers', { name: 'Ana', email: 'a@x.cl', holding_id: OTHER_HOLDING }).expect(403);
		});

		it('registro de otro holding → 404 del servicio', async () => {
			services.companies.get.mockRejectedValueOnce(new NotFoundException('Compañía no encontrada'));
			const res = await get(`/settings/companies/${ID}`).expect(404);

			expect(res.body.message).toBe('Compañía no encontrada');
			expect(services.companies.get).toHaveBeenCalledWith(HOLDING, ID);
		});

		it('países es catálogo global: solo sesión, sin header', async () => {
			const res = await get('/catalog/countries', 'nobody', null).expect(200);

			expect(res.body).toEqual([{ code: 'CL', name_es: 'Chile', name_en: 'Chile' }]);
		});
	});

	describe('permisos', () => {
		it('sin VIEW_CONFIGURACION no lee → 403 con el mensaje de D3', async () => {
			const res = await get('/settings/holding/tree', 'nobody').expect(403);

			expect(res.body.message).toBe('No tienes permiso para ver la configuración · pídeselo a un administrador');
		});

		it('con VIEW lee, pero no escribe', async () => {
			await get('/settings/sellers', 'reader').expect(200);
			const res = await send('post', '/settings/sellers', { name: 'Ana', email: 'a@x.cl' }, 'reader').expect(403);

			expect(res.body.message).toBe('No tienes permiso para editar la configuración · pídeselo a un administrador');
			expect(services.catalogs.createSeller).not.toHaveBeenCalled();
		});

		it('con EDIT escribe y el servicio recibe el holding del header', async () => {
			await send('post', '/settings/sellers', { name: 'Ana', email: 'a@x.cl' }).expect(201);
			expect(services.catalogs.createSeller).toHaveBeenCalledWith(HOLDING, { name: 'Ana', email: 'a@x.cl' });
		});

		it('ALL_PERMISSIONS y super admin pasan', async () => {
			await send('patch', '/settings/holding', { name: 'Hanka' }, 'all').expect(200);
			await send('patch', '/settings/holding', { name: 'Hanka' }, 'super').expect(200);
		});

		it('rol de otro holding no da permisos → 403', async () => {
			await get('/settings/holding', 'foreign_role').expect(403);
		});

		it('cerrar períodos exige CLOSE_PERIODS (EDIT_CONFIGURACION no alcanza)', async () => {
			const body = { until_date: '2026-08-31', reason: 'Cierre contable de agosto' };

			const res = await send('post', `/settings/companies/${ID}/periods/close`, body, 'editor').expect(403);

			expect(res.body.message).toContain('cerrar y reabrir períodos contables');
			await send('post', `/settings/companies/${ID}/periods/close`, body, 'closer').expect(200);
			expect(services.periods.close).toHaveBeenCalledWith(HOLDING, ID, body, expect.objectContaining({ userId: 'user-closer' }));
			await send('post', `/settings/companies/${ID}/periods/reopen`, { from_date: '2026-08-01', reason: 'Ajuste de factura' }, 'all').expect(
				200
			);
		});

		it('productos: VIEW_CONTRATOS lee, EDIT_CONTRATOS escribe; la configuración no alcanza', async () => {
			await get('/products', 'contracts_reader').expect(200);
			await send('post', '/products', { product_code: 'TMS', name: 'TMS' }, 'contracts_reader').expect(403);
			await send('post', '/products', { product_code: 'TMS', name: 'TMS' }, 'editor').expect(403);
			await send('post', '/products', { product_code: 'TMS', name: 'TMS' }, 'contracts_editor').expect(201);
			await send('post', `/products/${ID}/archive`, {}, 'contracts_editor').expect(200);
		});

		it('rutas de usuarios y roles entregan el contexto del actor', async () => {
			await send('patch', `/settings/users/${ID}/role`, { role_id: ID }).expect(200);
			expect(services.users.changeRole).toHaveBeenCalledWith(HOLDING, ID, ID, expect.objectContaining({ userId: 'user-editor' }));
			await send('post', `/settings/roles/${ID}/duplicate`, {}).expect(201);
			await send('put', `/settings/roles/${ID}/alerts`, { types: ['invoice_odoo_failure'] }).expect(200);
			await send('delete', `/settings/roles/${ID}`).expect(204);
		});
	});

	describe('validación', () => {
		it('campo desconocido → 400', async () => {
			await send('patch', '/settings/holding', { name: 'X', foo: 1 }).expect(400);
		});

		it('motivo de cierre corto → 400 con errors[{ field, message }]', async () => {
			const res = await send('post', `/settings/companies/${ID}/periods/close`, { until_date: '2026-08-31', reason: 'corto' }, 'closer').expect(
				400
			);

			expect(res.body.errors).toEqual([{ field: 'reason', message: 'El motivo debe tener al menos 10 caracteres' }]);
		});

		it('impuesto fuera de rango → 400', async () => {
			const res = await send('post', '/settings/companies', { legal_name: 'X', country_code: 'cl', currency: 'clp', tax_rate: 190 }).expect(
				400
			);

			expect(res.body.message).toContain('El impuesto va en porcentaje');
		});

		it('país y moneda se normalizan a mayúsculas antes del servicio', async () => {
			await send('post', '/settings/companies', { legal_name: 'Hanka SpA', country_code: 'cl', currency: 'clp', tax_rate: 19 }).expect(201);
			expect(services.companies.create).toHaveBeenLastCalledWith(
				HOLDING,
				expect.objectContaining({ country_code: 'CL', currency: 'CLP', tax_rate: 19 })
			);
		});

		it('field_name que no es snake_case → 400', async () => {
			await send('post', '/settings/custom-fields', {
				entity_type: 'contract',
				field_name: 'Proyecto Cliente',
				field_label: 'P',
				field_type: 'text',
			}).expect(400);
		});

		it('id que no es UUID → 400', async () => {
			await get('/settings/companies/abc').expect(400);
		});

		it('días de aviso fuera de 1–180 → 400', async () => {
			await send('patch', '/settings/holding/preferences', { auto_renewal_notice_days: 0 }).expect(400);
		});
	});
});

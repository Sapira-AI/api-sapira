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
import { SettingsCommunicationsController } from './settings-communications.controller';
import { SettingsCommunicationsService } from './settings-communications.service';
import { SettingsCompaniesController } from './settings-companies.controller';
import { SettingsCompaniesService } from './settings-companies.service';
import { SettingsCustomFieldsController } from './settings-custom-fields.controller';
import { SettingsCustomFieldsService } from './settings-custom-fields.service';
import { SettingsHoldingController } from './settings-holding.controller';
import { SettingsHoldingService } from './settings-holding.service';
import { SettingsRolesService } from './settings-roles.service';
import { SettingsTaxDocumentsController } from './settings-tax-documents.controller';
import { SettingsTaxDocumentsService } from './settings-tax-documents.service';
import { SettingsUserAccessService } from './settings-user-access.service';
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
	edit_only: { codes: ['EDIT_CONFIGURACION'] },
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
		access: autoMock(),
		roles: autoMock(),
		products: autoMock(),
		taxDocuments: autoMock(),
		communications: autoMock(),
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
				SettingsTaxDocumentsController,
				SettingsCommunicationsController,
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
				{ provide: SettingsUserAccessService, useValue: services.access },
				{ provide: SettingsRolesService, useValue: services.roles },
				{ provide: ProductsService, useValue: services.products },
				{ provide: SettingsTaxDocumentsService, useValue: services.taxDocuments },
				{ provide: SettingsCommunicationsService, useValue: services.communications },
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

	describe('ronda 3 (contrato §8)', () => {
		it('documentos tributarios: lectura con VIEW, sin PUT', async () => {
			await get(`/settings/companies/${ID}/tax-documents`, 'reader').expect(200);
			expect(services.taxDocuments.get).toHaveBeenCalledWith(HOLDING, ID);
			await send('put', `/settings/companies/${ID}/tax-documents`, { active_ids: [] }).expect(404);
		});

		it('comunicaciones: leer con VIEW, escribir con EDIT y siempre con el holding del header', async () => {
			await get('/settings/communications/domains', 'reader').expect(200);
			await send(
				'post',
				'/settings/communications/domains',
				{ sender_domain: 'mail.empresa.com', from_name: 'A', from_email: 'a@empresa.com' },
				'reader'
			).expect(403);
			await send('post', '/settings/communications/domains', {
				sender_domain: 'Mail.Empresa.com',
				from_name: 'A',
				from_email: 'a@empresa.com',
			}).expect(201);
			expect(services.communications.createDomain).toHaveBeenCalledWith(
				HOLDING,
				{ sender_domain: 'mail.empresa.com', from_name: 'A', from_email: 'a@empresa.com' },
				'editor'
			);
			const bad = await send('post', '/settings/communications/domains', {
				sender_domain: 'no es dominio',
				from_name: 'A',
				from_email: 'a@x.cl',
			}).expect(400);

			expect(bad.body.message).toContain('El dominio no es válido');
			await send('post', '/settings/communications/test-email', { to: 'ana@x.cl' }, 'reader').expect(403);
			// check-status escribe el estado guardado: POST con EDIT (Domi 03-10).
			await send('post', `/settings/communications/domains/${ID}/check-status`, {}, 'reader').expect(403);
			await send('post', `/settings/communications/domains/${ID}/check-status`).expect(200);
			expect(services.communications.checkStatus).toHaveBeenCalledWith(HOLDING, ID);
			await get(`/settings/communications/domains/${ID}/check-status`, 'editor').expect(404);
			await send('post', '/settings/communications/test-email', { to: 'ana@x.cl', holding_id: OTHER_HOLDING }).expect(403);
		});

		it('detalle FX valida fechas y año', async () => {
			await get('/settings/holding/fx-sync/history?currency=CLP&from=2026-02-30', 'reader').expect(400);
			await get('/settings/holding/fx-sync/monthly?currency=CLP&year=1990', 'reader').expect(400);
			await get('/settings/holding/fx-sync/monthly?currency=CLP&year=2026', 'reader').expect(200);
			expect(services.holding.fxSyncMonthly).toHaveBeenCalledWith(HOLDING, { currency: 'CLP', year: 2026 });
		});

		it('tipos de negocio y de contacto: solo lectura', async () => {
			await get('/settings/business-types', 'reader').expect(200);
			await get('/settings/contact-types', 'reader').expect(200);
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

		it('Editar incluye Ver: solo EDIT_CONFIGURACION lee la configuración', async () => {
			await get('/settings/holding', 'edit_only').expect(200);
		});

		it('ALL_PERMISSIONS y super admin pasan', async () => {
			await send('patch', '/settings/holding', { website: 'https://hanka.cl' }, 'all').expect(200);
			await send('patch', '/settings/holding', { website: 'https://hanka.cl' }, 'super').expect(200);
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

		it('acciones de acceso de usuarios (§10): EDIT_CONFIGURACION, holding del header y actor de la sesión', async () => {
			const actor = expect.objectContaining({ userId: 'user-editor' });

			await send('post', '/settings/users/invitations', { email: ' Ana@Cliente.CL ', name: ' Ana ', role_id: ID }).expect(201);
			expect(services.access.invite).toHaveBeenCalledWith(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ID }, actor);
			await send('post', `/settings/users/${ID}/invitation/resend`).expect(200);
			expect(services.access.resend).toHaveBeenCalledWith(HOLDING, ID, actor);
			await send('patch', `/settings/users/${ID}/access`, { active: false }).expect(200);
			expect(services.access.setAccess).toHaveBeenCalledWith(HOLDING, ID, false, actor);
			await send('delete', `/settings/users/${ID}`).expect(204);
			expect(services.access.removeInvitation).toHaveBeenCalledWith(HOLDING, ID, actor);
		});

		it('acciones de acceso: solo VIEW → 403; holding o invitador en el body → 400/403; validación', async () => {
			services.access.invite.mockClear();
			await send('post', '/settings/users/invitations', { email: 'a@b.cl', name: 'A', role_id: ID }, 'reader').expect(403);
			await send('patch', `/settings/users/${ID}/access`, { active: true }, 'reader').expect(403);
			await send('delete', `/settings/users/${ID}`, {}, 'reader').expect(403);
			await send('post', `/settings/users/${ID}/invitation/resend`, {}, 'reader').expect(403);
			await send('post', '/settings/users/invitations', { email: 'a@b.cl', name: 'A', role_id: ID, holding_id: OTHER_HOLDING }).expect(403);
			await send('post', '/settings/users/invitations', { email: 'a@b.cl', name: 'A', role_id: ID, invited_by: ID }).expect(400);
			await send('post', '/settings/users/invitations', { email: 'no-es-correo', name: 'A', role_id: ID }).expect(400);
			await send('post', '/settings/users/invitations', { email: 'a@b.cl', name: '', role_id: ID }).expect(400);
			await send('patch', `/settings/users/${ID}/access`, { active: 'no' }).expect(400);
			await send('delete', '/settings/users/no-uuid').expect(400);
			expect(services.access.invite).not.toHaveBeenCalled();
		});
	});

	describe('validación', () => {
		it('campo desconocido → 400', async () => {
			await send('patch', '/settings/holding', { website: 'X', foo: 1 }).expect(400);
		});

		it('el holding no se renombra: name → 400 con mensaje claro', async () => {
			const res = await send('patch', '/settings/holding', { name: 'Otro nombre' }).expect(400);

			expect(res.body.message).toBe('El nombre del holding no se puede cambiar');
		});

		it('fecha imposible en una tasa fija (2026-02-30) → 400, no 500', async () => {
			const res = await send('post', '/settings/holding/fx-rates', {
				from_currency: 'CLP',
				to_currency: 'USD',
				rate: 0.001,
				period_start: '2026-02-01',
				period_end: '2026-02-30',
			}).expect(400);

			expect(res.body.message).toBe('La fecha de fin no es válida (AAAA-MM-DD)');
		});

		it('errores esperables de Postgres → 4xx con mensaje (nunca 500 sin mensaje)', async () => {
			const overlap = Object.assign(
				new Error('Ya existe una tasa de cambio para este par de monedas en el período especificado. Los períodos no pueden superponerse.'),
				{ code: 'P0001' }
			);
			const unique = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'company_legal_documents_pkey' });
			const badDate = Object.assign(new Error('date/time field value out of range'), { code: '22008' });
			const body = { from_currency: 'CLP', to_currency: 'USD', rate: 0.001, period_start: '2026-01-01', period_end: '2026-01-31' };

			services.holding.createFxRate.mockRejectedValueOnce(overlap);
			expect((await send('post', '/settings/holding/fx-rates', body).expect(409)).body.message).toBe(
				'Ya existe una tasa para ese par en esas fechas'
			);
			services.holding.createFxRate.mockRejectedValueOnce(unique);
			expect((await send('post', '/settings/holding/fx-rates', body).expect(409)).body.message).toBe('Este documento ya está registrado');
			services.holding.createFxRate.mockRejectedValueOnce(badDate);
			expect((await send('post', '/settings/holding/fx-rates', body).expect(400)).body.message).toBe('La fecha no es válida');
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

		it('ronda 4: recordatorios repetidos o fuera de rango, numeración inválida → 400 con el mensaje', async () => {
			const cases: Array<[Record<string, unknown>, string]> = [
				[{ renewal_reminder_days: [30, 30] }, 'Hay días de recordatorio repetidos'],
				[{ renewal_reminder_days: [200] }, 'Los recordatorios deben ser días entre 0 y 180'],
				[{ renewal_reminder_days: [] }, 'Indica entre 1 y 10 recordatorios'],
				[{ renewal_overdue_every_days: 0 }, 'La frecuencia de recordatorios vencidos debe estar entre 1 y 90 días'],
				[{ quote_numbering: { mode: 'random' } }, 'Formato de numeración no válido: con prefijo, correlativo o manual'],
				[{ quote_numbering: { prefix: 'CO-T' } }, 'El prefijo solo admite letras y números (máximo 10)'],
				[{ quote_numbering: { width: 9 } }, 'El ancho del correlativo debe estar entre 1 y 8'],
			];

			for (const [body, message] of cases) {
				const response = await send('patch', '/settings/holding/preferences', body).expect(400);

				expect(JSON.stringify(response.body)).toContain(message);
			}
		});

		it('ronda 4: preferencias válidas llegan al servicio', async () => {
			await send('patch', '/settings/holding/preferences', {
				renewal_overdue_every_days: 14,
				renewal_reminder_days: [90, 30, 0],
				quote_numbering: { mode: 'manual' },
				timezone: 'America/Lima',
			}).expect(200);
		});
	});
});

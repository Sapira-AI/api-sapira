import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PermissionsService } from '@/guards/permissions.service';
import { REQUIRED_PERMISSIONS_KEY, RequirePermissionGuard } from '@/guards/require-permission.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { ProductsController } from '@/modules/products/products.controller';
import { ProductsModule } from '@/modules/products/products.module';

import { CountriesController } from './countries.controller';
import { SettingsAccessController } from './settings-access.controller';
import { SettingsCatalogsController } from './settings-catalogs.controller';
import { SettingsCompaniesController } from './settings-companies.controller';
import { SettingsCustomFieldsController } from './settings-custom-fields.controller';
import { SettingsHoldingController } from './settings-holding.controller';
import { SettingsModule } from './settings.module';

/**
 * Guarda estática: todo controlador de Configuración y Productos lleva los tres guards en orden y **ninguna ruta de escritura queda con
 * el permiso de lectura** (el de clase es VIEW; cada POST/PATCH/PUT/DELETE debe declarar EDIT o CLOSE_PERIODS).
 */
const SCOPED = [
	{ controller: SettingsHoldingController, view: 'VIEW_CONFIGURACION', write: ['EDIT_CONFIGURACION'] },
	{ controller: SettingsCatalogsController, view: 'VIEW_CONFIGURACION', write: ['EDIT_CONFIGURACION'] },
	{ controller: SettingsCustomFieldsController, view: 'VIEW_CONFIGURACION', write: ['EDIT_CONFIGURACION'] },
	{ controller: SettingsCompaniesController, view: 'VIEW_CONFIGURACION', write: ['EDIT_CONFIGURACION', 'CLOSE_PERIODS'] },
	{ controller: SettingsAccessController, view: 'VIEW_CONFIGURACION', write: ['EDIT_CONFIGURACION'] },
	{ controller: ProductsController, view: 'VIEW_CONTRATOS', write: ['EDIT_CONTRATOS'] },
];

const routesOf = (controller: { prototype: object }) =>
	Object.getOwnPropertyNames(controller.prototype)
		.filter((name) => name !== 'constructor')
		.map((name) => {
			const handler = (controller.prototype as Record<string, unknown>)[name] as object;

			return { name, method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined, handler };
		})
		.filter((route) => route.method !== undefined);

describe('Controladores de Configuración y Productos', () => {
	it.each(SCOPED)('$controller.name: SupabaseAuthGuard → HoldingScopeGuard → RequirePermissionGuard', ({ controller }) => {
		expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard]);
	});

	it.each(SCOPED)('$controller.name: lectura con VIEW y cada escritura con su permiso', ({ controller, view, write }) => {
		expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, controller)).toEqual([view]);
		for (const route of routesOf(controller)) {
			const codes = (Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, route.handler) as string[] | undefined) ?? [view];

			if (route.method === RequestMethod.GET) expect({ route: route.name, codes }).toEqual({ route: route.name, codes: [view] });
			else expect({ route: route.name, ok: codes.every((code) => write.includes(code)) }).toEqual({ route: route.name, ok: true });
		}
	});

	it('cierre y reapertura de períodos exigen CLOSE_PERIODS', () => {
		for (const name of ['closePeriod', 'reopenPeriod']) {
			const handler = (SettingsCompaniesController.prototype as unknown as Record<string, object>)[name];

			expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual(['CLOSE_PERIODS']);
		}
	});

	it('países: solo sesión (catálogo global, sin holding)', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, CountriesController)).toEqual([SupabaseAuthGuard]);
	});

	it('SettingsModule y ProductsModule resuelven sus dependencias (guards globales, DataSource, Config, Notificaciones)', async () => {
		const metadata = (module: object, key: string) => (Reflect.getMetadata(key, module) as unknown[]) ?? [];
		const moduleRef = await Test.createTestingModule({
			controllers: [
				...metadata(SettingsModule, MODULE_METADATA.CONTROLLERS),
				...metadata(ProductsModule, MODULE_METADATA.CONTROLLERS),
			] as never[],
			providers: [
				...(metadata(SettingsModule, MODULE_METADATA.PROVIDERS) as never[]),
				...(metadata(ProductsModule, MODULE_METADATA.PROVIDERS) as never[]),
				HoldingScopeGuard,
				RequirePermissionGuard,
				PermissionsService,
				{ provide: UserHoldingsService, useValue: {} },
				{ provide: DataSource, useValue: { query: jest.fn() } },
				{ provide: ConfigService, useValue: { get: jest.fn() } },
				{ provide: NotificationsService, useValue: {} },
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({ canActivate: () => true })
			.compile();

		expect(moduleRef.get(SettingsCompaniesController)).toBeDefined();
		expect(moduleRef.get(ProductsController)).toBeDefined();
		expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, SettingsModule)).toEqual(expect.arrayContaining([expect.anything()]));
		await moduleRef.close();
	});
});

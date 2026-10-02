// `InvoiceSchedulerService` (vía `ContractsModule`) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { ContractInvoicesService } from '@/modules/contracts/contract-invoices.service';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { EmailsService } from '@/modules/emails/emails.service';

import { BillingBulkService } from './billing-bulk.service';
import { BillingCollectionsService } from './billing-collections.service';
import { BillingExportService } from './billing-export.service';
import { BillingPaymentsService } from './billing-payments.service';
import { BillingPermissionGuard, BillingPermissionsService } from './billing-permissions.service';
import { BillingReadService } from './billing-read.service';
import { BillingReconciliationController } from './billing-reconciliation.controller';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingController } from './billing.controller';
import { BillingModule } from './billing.module';
import { BILLING_REMINDERS_JOB, BillingScheduler } from './billing.scheduler';

/**
 * Cableado sin levantar Nest contra la base: (1) cada dependencia de constructor tiene provider en el módulo o la exporta un módulo importado
 * (`ContractsModule` → `ContractInvoicesService`, `ContractsService`; `EmailsModule` → `EmailsService`; `DataSource`; `ConfigService` global);
 * (2) Nest resuelve el grafo real del módulo con esas piezas externas sustituidas.
 */
describe('BillingModule (DI)', () => {
	const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BillingModule) as Array<new (...args: never[]) => unknown>;
	const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BillingModule) as Array<new (...args: never[]) => unknown>;
	const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, BillingModule) as unknown[];
	const exported = imports.flatMap((imported) => (Reflect.getMetadata(MODULE_METADATA.EXPORTS, imported as object) as unknown[] | undefined) ?? []);
	// `Reflector` lo aporta el núcleo de Nest en todo módulo.
	const available = new Set<unknown>([...providers, ...exported, DataSource, ConfigService, Reflector]);
	const dependenciesOf = (target: unknown) => (Reflect.getMetadata('design:paramtypes', target as object) as unknown[] | undefined) ?? [];

	it('toda dependencia de controlador y servicios está disponible en el módulo', () => {
		for (const target of [...controllers, ...providers]) {
			for (const dependency of dependenciesOf(target)) {
				expect({ target: target.name, dependency: (dependency as { name?: string })?.name, ok: available.has(dependency) }).toMatchObject({
					ok: true,
				});
			}
		}
		expect(exported).toEqual(expect.arrayContaining([ContractInvoicesService, ContractsService, EmailsService]));
	});

	it('Nest resuelve controladores (incluida conciliación), servicios y el job (apagado sin BILLING_REMINDERS_ENABLED)', async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [BillingController, BillingReconciliationController],
			providers: [
				...providers,
				{ provide: DataSource, useValue: { query: jest.fn(async () => []) } },
				{ provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
				{ provide: ContractInvoicesService, useValue: {} },
				{ provide: ContractsService, useValue: {} },
				{ provide: EmailsService, useValue: {} },
			],
		})
			// Los guards de ruta los aporta la app (AuthModule/GuardsModule globales); aquí se sustituyen.
			.overrideGuard(SupabaseAuthGuard)
			.useValue({ canActivate: () => true })
			.overrideGuard(HoldingScopeGuard)
			.useValue({ canActivate: () => true })
			.compile();

		for (const token of [
			BillingController,
			BillingReadService,
			BillingPaymentsService,
			BillingPermissionsService,
			BillingPermissionGuard,
			BillingCollectionsService,
			BillingBulkService,
			BillingExportService,
			BillingScheduler,
			BillingReconciliationController,
			BillingReconciliationService,
		]) {
			expect(moduleRef.get(token)).toBeInstanceOf(token);
		}
		const scheduler = moduleRef.get(BillingScheduler);

		expect(scheduler.enabled).toBe(false);
		expect(await scheduler.remindersDaily()).toBeNull();
		expect(BILLING_REMINDERS_JOB).toBe('billing-reminders');
	});
});

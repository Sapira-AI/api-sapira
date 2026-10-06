// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ContractsModule } from './contracts.module';

/**
 * Cableado del módulo sin levantar Nest ni tocar la base (levantar una segunda instancia contra el `.env` por defecto
 * arrancaría los schedulers): cada dependencia de constructor de controladores y servicios tiene su provider en el módulo
 * o la exporta un módulo importado (`DataSource` de `PostgreSQLDatabaseModule`, `HoldingMetricsService` de `MetricsModule`;
 * `ConfigService` es global).
 */
describe('ContractsModule (cableado)', () => {
	const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ContractsModule) as Array<new (...args: never[]) => unknown>;
	const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ContractsModule) as Array<new (...args: never[]) => unknown>;
	const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ContractsModule) as unknown[];
	const exported = imports.flatMap((imported) => (Reflect.getMetadata(MODULE_METADATA.EXPORTS, imported as object) as unknown[] | undefined) ?? []);
	const available = new Set<unknown>([...providers, ...exported, DataSource, ConfigService]);
	const dependenciesOf = (target: unknown) => (Reflect.getMetadata('design:paramtypes', target as object) as unknown[] | undefined) ?? [];

	it('registra los controladores de contratos, métricas facturables, consumo, catálogo de precios y unificación recurrente', () => {
		expect(controllers.map((controller) => controller.name).sort()).toEqual([
			'BillableMetricsController',
			'ConsumptionController',
			'ContractsController',
			'InvoiceConsolidationRulesController',
			'PricesController',
		]);
	});

	it('registra los servicios de facturas del 360 (operaciones, descripciones, edición y reorganización de Por Emitir)', () => {
		expect(providers.map((provider) => provider.name)).toEqual(
			expect.arrayContaining([
				'ContractInvoicesService',
				'ContractInvoiceDescriptionsService',
				'ContractInvoiceEditService',
				'ContractInvoiceReorganizeService',
				'ContractInvoiceVoidService',
				'ContractInvoicePartialPoService',
				'ContractInvoiceConsolidationService',
			])
		);
	});

	it.each([
		['controladores', () => controllers],
		['servicios', () => providers],
	])('%s: toda dependencia de constructor tiene provider', (_label, list) => {
		const missing = list().flatMap((target) =>
			dependenciesOf(target)
				.filter((dependency) => !available.has(dependency))
				.map((dependency) => `${target.name} ← ${(dependency as { name?: string })?.name ?? String(dependency)}`)
		);

		expect(missing).toEqual([]);
	});
});

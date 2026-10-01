// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { QuotesModule } from './quotes.module';

/**
 * Cableado del módulo sin levantar Nest ni tocar la base (una segunda instancia contra el `.env` por defecto arrancaría los
 * schedulers): cada dependencia de constructor tiene su provider en el módulo o la exporta un módulo importado
 * (`DataSource` de `PostgreSQLDatabaseModule`, `ContractDraftsService` de `ContractsModule`; `ConfigService` es global).
 */
describe('QuotesModule (cableado)', () => {
	const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, QuotesModule) as Array<new (...args: never[]) => unknown>;
	const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QuotesModule) as Array<new (...args: never[]) => unknown>;
	const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, QuotesModule) as unknown[];
	const exported = imports.flatMap((imported) => (Reflect.getMetadata(MODULE_METADATA.EXPORTS, imported as object) as unknown[] | undefined) ?? []);
	const available = new Set<unknown>([...providers, ...exported, DataSource, ConfigService]);
	const dependenciesOf = (target: unknown) => (Reflect.getMetadata('design:paramtypes', target as object) as unknown[] | undefined) ?? [];

	it('registra los controladores de cotizaciones y etapas', () => {
		expect(controllers.map((controller) => controller.name).sort()).toEqual(['QuoteStagesController', 'QuotesController']);
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

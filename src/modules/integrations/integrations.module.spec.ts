jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { MODULE_METADATA, PARAMTYPES_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { HoldingIntegrationSettings } from '@/databases/postgresql/entities/base-tenancy/holding-integration-settings.entity';
import { OdooConnection } from '@/databases/postgresql/entities/integraciones/odoo/odoo-connection.entity';
import { BigQueryConnection } from '@/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity';
import { SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { StripeConnection } from '@/databases/postgresql/entities/integraciones/stripe/stripe-connection.entity';
import { BigQueryModule } from '@/modules/bigquery/bigquery.module';
import { ClientsModule } from '@/modules/clients/clients.module';
import { InvoicesModule } from '@/modules/invoices/invoices.module';
import { InvoiceSchedulerJob } from '@/modules/invoices/schemas/invoice-scheduler-job.schema';
import { OdooModule } from '@/modules/odoo/odoo.module';
import { SalesforceModule } from '@/modules/salesforce/salesforce.module';
import { SalesforceSchedulerJob } from '@/modules/salesforce/schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog } from '@/modules/salesforce/schemas/salesforce-sync-log.schema';
import { StripeIntegrationLog } from '@/modules/stripe/schemas/stripe-integration-log.schema';
import { StripeModule } from '@/modules/stripe/stripe.module';

import { CrmAdapter } from './adapters/crm.adapter';
import { DatosAdapter } from './adapters/datos.adapter';
import { ErpAdapter } from './adapters/erp.adapter';
import { StripeAdapter } from './adapters/stripe.adapter';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsModule } from './integrations.module';
import { IntegrationsService } from './integrations.service';

/**
 * Cableado de Nest (tsc y las specs con mocks no detectan una falla de arranque): cada dependencia de los providers del módulo debe venir
 * de un export de los módulos importados, de un `forFeature` propio, de los globales (`DataSource`, `ConfigService`) o del propio módulo.
 */
describe('IntegrationsModule · cableado', () => {
	const exportsOf = (module: object) => (Reflect.getMetadata(MODULE_METADATA.EXPORTS, module) as unknown[]) ?? [];

	it('toda dependencia de los adaptadores y el servicio se resuelve', () => {
		const available = new Set<unknown>([
			...[OdooModule, SalesforceModule, StripeModule, BigQueryModule, InvoicesModule, ClientsModule].flatMap(exportsOf),
			DataSource,
			ConfigService,
			ErpAdapter,
			CrmAdapter,
			StripeAdapter,
			DatosAdapter,
			...[OdooConnection, SalesforceConnection, StripeConnection, BigQueryConnection, HoldingIntegrationSettings].map((entity) =>
				getRepositoryToken(entity)
			),
			...[InvoiceSchedulerJob, SalesforceSchedulerJob, SalesforceSyncLog, StripeIntegrationLog].map((schema) => getModelToken(schema.name)),
		]);
		const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IntegrationsModule) as Array<new (...args: never[]) => unknown>;

		expect(providers).toEqual(expect.arrayContaining([IntegrationsService, ErpAdapter, CrmAdapter, StripeAdapter, DatosAdapter]));
		expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, IntegrationsModule)).toEqual([IntegrationsController]);
		for (const provider of providers) {
			const params = (Reflect.getMetadata(PARAMTYPES_METADATA, provider) as unknown[]) ?? [];
			const overrides = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, provider) as Array<{ index: number; param: unknown }>) ?? [];
			const tokens = params.map((param, index) => overrides.find((item) => item.index === index)?.param ?? param);
			const missing = tokens
				.filter((token) => !available.has(token))
				.map((token) => (typeof token === 'function' ? token.name : String(token)));

			expect({ provider: provider.name, missing }).toEqual({ provider: provider.name, missing: [] });
		}
	});
});

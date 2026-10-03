import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { InvoicesModule } from '@/modules/invoices/invoices.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { BillableMetricsController } from './billable-metrics.controller';
import { BillableMetricsService } from './billable-metrics.service';
import { ConsumptionController } from './consumption.controller';
import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceConsolidationService } from './contract-invoice-consolidation.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicePartialPoService } from './contract-invoice-partial-po.service';
import { ContractInvoiceReorganizeService } from './contract-invoice-reorganize.service';
import { ContractInvoiceVoidService } from './contract-invoice-void.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractRenewalsService } from './contract-renewals.service';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsScheduler } from './contracts.scheduler';
import { ContractsService } from './contracts.service';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { ContractDocumentsStorageService } from './storage/contract-documents-storage.service';

/** Contratos v2: lectura (§2a), creación de borradores con vista previa (C1, §3), activación (C2), borrado lógico (C5), configuración masiva, Pricing v2 (métricas facturables, precios inline, catálogo de precios versionado, consumos) y modificaciones con vista previa (`spec-modificaciones-contrato-v2.md` §4); facturas del contrato (`spec-facturas-en-contrato-360.md` §3.1–3.3: enviar al ERP ahora, emisión externa, reprogramar, tipo de cambio por factura; §3.6–3.7a: constructor de descripción y referencias OC/HES; §3.4: editar una Por Emitir con conciliador de desvíos y restablecer el borrador del ERP; §3.5: reorganizar el cronograma; §3.7b–3.8: facturar por OC, anular con NC espejo y reemitir, NC de descuento; consolidación opcional entre contratos, `spec-multimoneda-contrato.md` §7; `InvoicesModule` aporta el envío del scheduler). Jobs diarios `contracts-auto-renewal` y `contracts-scheduled-changes` (`ContractsScheduler`, §9.3.5–§9.3.6; `NotificationsModule` aporta las notificaciones). Ver `docs/v2-rediseno/mapa-v2-contratos.md` y `spec-pricing-v2.md`. */
@Module({
	imports: [PostgreSQLDatabaseModule, MetricsModule, InvoicesModule, NotificationsModule],
	controllers: [ContractsController, BillableMetricsController, ConsumptionController, PricesController],
	providers: [
		ContractsService,
		ContractDraftsService,
		ContractSubscriptionsService,
		Contract360Service,
		ContractBulkService,
		ContractActivationService,
		ContractChangesService,
		ContractInvoicesService,
		ContractInvoiceDescriptionsService,
		ContractInvoiceEditService,
		ContractInvoiceReorganizeService,
		ContractInvoiceVoidService,
		ContractInvoicePartialPoService,
		ContractInvoiceConsolidationService,
		ContractScheduledChangesService,
		ContractRenewalsService,
		ContractsScheduler,
		ContractDocumentsStorageService,
		ConsumptionService,
		BillableMetricsService,
		PricesService,
	],
	exports: [ContractsService, ContractDraftsService, ContractInvoicesService, ConsumptionService],
})
export class ContractsModule {}

import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { BudgetsModule } from '@/modules/budgets/budgets.module';
import { ContractsModule } from '@/modules/contracts/contracts.module';
import { EmailsModule } from '@/modules/emails/emails.module';

import { BillingBulkService } from './billing-bulk.service';
import { BillingCollectionsService } from './billing-collections.service';
import { BillingExportService } from './billing-export.service';
import { BillingPaymentsService } from './billing-payments.service';
import { BillingPermissionGuard, BillingPermissionsService } from './billing-permissions.service';
import { BillingReadService } from './billing-read.service';
import { BillingReconciliationController } from './billing-reconciliation.controller';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingController } from './billing.controller';
import { BillingScheduler } from './billing.scheduler';

/**
 * Facturación v2 (`docs/v2-rediseno/spec-facturacion-v2.md`, `mapa-v2-facturacion.md`): lecturas por holding, pagos, correos de cobro,
 * proforma, recordatorios (job `billing-reminders`, apagado por defecto) y el fan-out de la cola Por emitir hacia los servicios del contrato
 * (`ContractsModule` exporta `ContractInvoicesService` y `ContractsService`; `EmailsModule`, el envío SendGrid). Conciliación bancaria v2
 * (`spec-conciliacion-v2.md`): `BillingReconciliationController` + `BillingReconciliationService` (pagos por `BillingPaymentsService`).
 * Presupuesto de ingresos a caja (meta de cobranza y proyección): `BudgetsModule` exporta `BudgetsService`.
 */
@Module({
	imports: [PostgreSQLDatabaseModule, ContractsModule, EmailsModule, BudgetsModule],
	controllers: [BillingController, BillingReconciliationController],
	providers: [
		BillingReadService,
		BillingPaymentsService,
		BillingPermissionsService,
		BillingPermissionGuard,
		BillingCollectionsService,
		BillingBulkService,
		BillingExportService,
		BillingScheduler,
		BillingReconciliationService,
	],
})
export class BillingModule {}

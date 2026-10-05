import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { BillingPermissionGuard } from '@/modules/billing/billing-permissions.service';

import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';

/**
 * Presupuestos genéricos (`budgets` + `budget_lines`, migración `1790750000000-Budgets`). Exporta `BudgetsService` para la meta de cobranza
 * y la proyección de cobros (`BillingModule` lo importa). Los permisos reutilizan el guard de Facturación (`BillingPermissionGuard`,
 * injectable sin estado sobre `PermissionsService` de `GuardsModule`, global): se provee aquí sin importar `BillingModule`, que a su vez
 * importa este módulo.
 */
@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [BudgetsController],
	providers: [BudgetsService, BillingPermissionGuard],
	exports: [BudgetsService],
})
export class BudgetsModule {}

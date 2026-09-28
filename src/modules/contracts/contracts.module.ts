import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';

import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

/** Contratos v2: lectura (§2a), creación de borradores con vista previa (C1, §3), activación (C2), borrado lógico (C5) y configuración masiva. Ver `docs/v2-rediseno/mapa-v2-contratos.md`. */
@Module({
	imports: [PostgreSQLDatabaseModule, MetricsModule],
	controllers: [ContractsController],
	providers: [
		ContractsService,
		ContractDraftsService,
		ContractSubscriptionsService,
		Contract360Service,
		ContractBulkService,
		ContractActivationService,
	],
	exports: [ContractsService, ContractDraftsService],
})
export class ContractsModule {}

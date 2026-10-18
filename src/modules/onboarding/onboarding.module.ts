import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ContractsModule } from '@/modules/contracts/contracts.module';

import { OnboardingHistoryService } from './onboarding-history.service';
import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';
import { OnboardingSeriesService } from './onboarding-series.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding de datos históricos y MRR histórico v2 (`docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md`, entrega 1; formas en
 * `mapa-v2-onboarding.md`). Usa el generador común de Contratos (`ContractDraftsService`). Los guards vienen de `GuardsModule` (global).
 */
@Module({
	imports: [PostgreSQLDatabaseModule, ContractsModule],
	controllers: [OnboardingController],
	providers: [
		OnboardingService,
		OnboardingHistoryService,
		OnboardingPreviousInvoicesService,
		OnboardingRegisterService,
		OnboardingQuickStartService,
		OnboardingSeriesService,
	],
})
export class OnboardingModule {}

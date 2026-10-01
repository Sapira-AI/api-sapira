import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ContractsModule } from '@/modules/contracts/contracts.module';

import { QuoteListService } from './quote-list.service';
import { QuoteStagesService } from './quote-stages.service';
import { QuotesController, QuoteStagesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/** Cotizaciones v2 (`docs/v2-rediseno/mapa-v2-cotizaciones.md`): lista, 360, alta/edición con Pricing v2, etapas con `kind`, transiciones y costura con Contratos. */
@Module({
	imports: [PostgreSQLDatabaseModule, ContractsModule],
	controllers: [QuotesController, QuoteStagesController],
	providers: [QuoteListService, QuotesService, QuoteStagesService],
	exports: [QuoteListService, QuotesService],
})
export class QuotesModule {}

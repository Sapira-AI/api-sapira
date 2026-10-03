import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { HoldingMetricsService } from './holding-metrics.service';
import { MetricsDataService } from './metrics-data.service';
import { MetricsController } from './metrics.controller';
import { MrrMetricsService } from './mrr-metrics.service';
import { RevenueMetricsService } from './revenue-metrics.service';

/**
 * Métricas del holding: `HoldingMetricsService` (MRR y clientes activos del Dashboard y Clientes) y los endpoints de solo lectura de
 * Revenue y Métricas v2 (`/metrics/*`, spec-revenue-y-metricas).
 */
@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [MetricsController],
	providers: [HoldingMetricsService, MetricsDataService, MrrMetricsService, RevenueMetricsService],
	exports: [HoldingMetricsService, RevenueMetricsService, MrrMetricsService],
})
export class MetricsModule {}

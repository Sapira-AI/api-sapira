import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { HoldingMetricsService } from './holding-metrics.service';

/** Métricas del holding con una sola definición (MRR, clientes activos, moneda), para Dashboard y Clientes. */
@Module({
	imports: [PostgreSQLDatabaseModule],
	providers: [HoldingMetricsService],
	exports: [HoldingMetricsService],
})
export class MetricsModule {}

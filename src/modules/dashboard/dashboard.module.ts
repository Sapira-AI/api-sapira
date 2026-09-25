import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
	imports: [PostgreSQLDatabaseModule, MetricsModule],
	controllers: [DashboardController],
	providers: [DashboardService],
})
export class DashboardModule {}

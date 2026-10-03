import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';
import { TasksModule } from '@/modules/tasks/tasks.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
	imports: [PostgreSQLDatabaseModule, MetricsModule, TasksModule],
	controllers: [DashboardController],
	providers: [DashboardService],
})
export class DashboardModule {}

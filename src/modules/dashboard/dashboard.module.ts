import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [DashboardController],
	providers: [DashboardService],
})
export class DashboardModule {}

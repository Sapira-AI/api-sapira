import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { DatabaseAnalyzerController } from './database-analyzer.controller';
import { DatabaseAnalyzerService } from './database-analyzer.service';

@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [DatabaseAnalyzerController],
	providers: [DatabaseAnalyzerService],
	exports: [DatabaseAnalyzerService],
})
export class DatabaseAnalyzerModule {}

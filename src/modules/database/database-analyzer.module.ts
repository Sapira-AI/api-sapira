import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { DatabaseAnalyzerController } from './database-analyzer.controller';
import { DatabaseAnalyzerService } from './database-analyzer.service';
import { DatabaseGeneratorService } from './database-generator.service';

@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [DatabaseAnalyzerController],
	providers: [DatabaseAnalyzerService, DatabaseGeneratorService],
	exports: [DatabaseAnalyzerService, DatabaseGeneratorService],
})
export class DatabaseAnalyzerModule {}

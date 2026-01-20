import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { ClaudeController } from './claude.controller';
import { ClaudeProviders } from './claude.provider';
import { ClaudeService } from './claude.service';
import { DynamicQueryBuilder } from './skills/query-builder';
import { SkillExecutor } from './skills/skill-executor';

@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [ClaudeController],
	providers: [ClaudeService, DynamicQueryBuilder, SkillExecutor, ...ClaudeProviders],
	exports: [ClaudeService],
})
export class ClaudeModule {}

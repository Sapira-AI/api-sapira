import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClaudeModule } from '@/modules/claude/claude.module';

import { SapiraCopilotController } from './sapira-copilot.controller';
import { SapiraCopilotProviders } from './sapira-copilot.provider';
import { SapiraCopilotService } from './sapira-copilot.service';

@Module({
	imports: [PostgreSQLDatabaseModule, AuthModule, ClaudeModule],
	controllers: [SapiraCopilotController],
	providers: [SapiraCopilotService, ...SapiraCopilotProviders],
	exports: [SapiraCopilotService],
})
export class SapiraCopilotModule {}

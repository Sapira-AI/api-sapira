import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { EmailsModule } from '../emails/emails.module';

import { AgentsController } from './agents.controller';
import { AgentsProviders } from './agents.provider';
import { AgentsScheduler } from './agents.scheduler';
import { AgentsService } from './agents.service';
import { CollectionsProcessor } from './processors/collections.processor';
import { ProformaProcessor } from './processors/proforma.processor';

@Module({
	imports: [PostgreSQLDatabaseModule, AuthModule, EmailsModule],
	controllers: [AgentsController],
	providers: [AgentsService, AgentsScheduler, ProformaProcessor, CollectionsProcessor, ...AgentsProviders],
	exports: [AgentsService],
})
export class AgentsModule {}

import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { EmailsController } from './emails.controller';
import { EmailsProviders } from './emails.provider';
import { EmailsService } from './emails.service';

@Module({
	imports: [PostgreSQLDatabaseModule, AuthModule],
	controllers: [EmailsController],
	providers: [EmailsService, ...EmailsProviders],
	exports: [EmailsService],
})
export class EmailsModule {}

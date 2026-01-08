import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { EmailController } from './email.controller';
import { EmailProviders } from './email.provider';
import { EmailService } from './email.service';

@Module({
	imports: [PostgreSQLDatabaseModule, AuthModule],
	controllers: [EmailController],
	providers: [EmailService, ...EmailProviders],
	exports: [EmailService],
})
export class EmailModule {}

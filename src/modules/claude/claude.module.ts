import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { ClaudeController } from './claude.controller';
import { ClaudeProviders } from './claude.provider';
import { ClaudeService } from './claude.service';

@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [ClaudeController],
	providers: [
		ClaudeService,
		...ClaudeProviders,
		{
			provide: 'SUPABASE_CLIENT',
			useFactory: (configService: ConfigService) => {
				return createClient(configService.get('SUPABASE_URL'), configService.get('SUPABASE_ANON_KEY'));
			},
			inject: [ConfigService],
		},
	],
	exports: [ClaudeService, 'SUPABASE_CLIENT'],
})
export class ClaudeModule {}

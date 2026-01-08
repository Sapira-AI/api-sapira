import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';

import { BigQueryController } from './bigquery.controller';
import { BigQueryProviders } from './bigquery.provider';
import { BigQueryService } from './bigquery.service';

@Module({
	imports: [AuthModule],
	controllers: [BigQueryController],
	providers: [BigQueryService, ...BigQueryProviders],
	exports: [BigQueryService],
})
export class BigQueryModule {}

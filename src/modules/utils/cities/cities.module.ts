import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { MongooseModules } from '../../../databases/mongoose/database.module';

import { CitiesController } from './cities.controller';
import { CitiesProviders } from './cities.provider';
import { CitiesService } from './cities.service';

@Module({
	imports: [
		PassportModule.register({
			defaultStrategy: 'AzureAD',
		}),
		MongooseModules,
	],
	controllers: [CitiesController],
	providers: [CitiesService, ...CitiesProviders],
})
export class CitiesModule {}

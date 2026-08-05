import { Module } from '@nestjs/common';

import { MongooseModules } from '../../../databases/mongoose/database.module';

import { CitiesController } from './cities.controller';
import { CitiesProviders } from './cities.provider';
import { CitiesService } from './cities.service';

@Module({
	imports: [MongooseModules],
	controllers: [CitiesController],
	providers: [CitiesService, ...CitiesProviders],
})
export class CitiesModule {}

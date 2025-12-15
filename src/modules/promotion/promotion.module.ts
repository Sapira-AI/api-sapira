import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { MongooseModules } from '../../databases/mongoose/database.module';

import { PromotionController } from './promotion.controller';
import { PromotionProvider } from './promotion.provider';
import { PromotionService } from './promotion.service';

@Module({
	imports: [
		PassportModule.register({
			defaultStrategy: 'AzureAD',
		}),
		MongooseModules,
	],
	controllers: [PromotionController],
	providers: [PromotionService, ...PromotionProvider],
})
export class PromotionModule {}

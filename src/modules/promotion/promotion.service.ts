import { Inject, Injectable } from '@nestjs/common';
import { Model } from 'mongoose';

import { Promotion } from './schemas/promotion.schema';

@Injectable()
export class PromotionService {
	constructor(@Inject('PromotionModelToken') private readonly promotionModel: Model<Promotion>) {}

	async getPromotion() {
		const promotion = await this.promotionModel.find();
		return promotion;
	}
}

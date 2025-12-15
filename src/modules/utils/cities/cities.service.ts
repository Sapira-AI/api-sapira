import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Model } from 'mongoose';

import { Cities } from './cities.schema';

@Injectable()
export class CitiesService {
	constructor(@Inject('CitiesModelToken') private readonly citiesModel: Model<Cities>) {}

	async getDistricts(code_region: string) {
		const districts = await this.citiesModel.find({ code_region: code_region }, { code_citie: 1, name_citie: 1, _id: 0 }).sort({ name_citie: 1 });
		return districts;
	}

	async getRegions() {
		try {
			const regions = await this.citiesModel.aggregate([
				{
					$group: {
						_id: { code_region: '$code_region', name_region: '$name_region' },
					},
				},
				{
					$project: {
						_id: 0,
						code_region: '$_id.code_region',
						name_region: '$_id.name_region',
					},
				},
				{ $sort: { name_region: 1 } },
			]);
			return regions;
		} catch (error) {
			if (error.message.includes('Failed to parse number')) {
				throw new HttpException('code_reg must be a number', HttpStatus.INTERNAL_SERVER_ERROR);
			}
			throw new HttpException('An unexpected error occurred', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	async updateRegion(code_reg, body) {
		const updatedRegion = await this.citiesModel
			.updateMany(
				{ code_reg: code_reg },
				{
					$set: {
						code_reg: body.code_reg,
						name_reg: body.name_reg,
					},
				},
				{ new: true }
			)
			.lean();
		return updatedRegion;
	}

	async getDistrictsAndRegions() {
		try {
			const regions = await this.citiesModel.find().exec();
			return regions;
		} catch (error) {
			if (error.message.includes('Failed to parse number')) {
				throw new HttpException('code_reg must be a number', HttpStatus.INTERNAL_SERVER_ERROR);
			}
			throw new HttpException('An unexpected error occurred', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}
}

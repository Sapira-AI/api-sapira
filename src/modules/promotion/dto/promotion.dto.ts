import { ApiProperty } from '@nestjs/swagger';

import { RepublishOptions } from '../schemas/republish-options.schema';

export class PromotionDTO {
	@ApiProperty({ required: false })
	code?: string;

	@ApiProperty({ required: false })
	title?: string;

	@ApiProperty({ required: false })
	subtitle?: string;

	@ApiProperty({ required: false })
	price?: string;

	@ApiProperty({ required: false })
	amount?: number;

	@ApiProperty({ required: false })
	featured?: boolean;

	@ApiProperty({ required: false })
	features?: string[];

	@ApiProperty({ required: false })
	promotion?: RepublishOptions[];

	@ApiProperty({ required: false })
	selected?: boolean;

	@ApiProperty({ required: false })
	default?: boolean;
}

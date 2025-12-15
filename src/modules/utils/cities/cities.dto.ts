import { ApiProperty, PartialType } from '@nestjs/swagger';

export class DistrictDTO {
	@ApiProperty({ required: true })
	code_citie: string;

	@ApiProperty({ required: true })
	name_citie: string;
}

export class RegionDTO {
	@ApiProperty({ required: true })
	code_region: string;

	@ApiProperty({ required: true })
	name_region: string;
}

export class RegionUpdateDTO {
	@ApiProperty({ required: false })
	code_region: string;

	@ApiProperty({ required: false })
	name_region: string;
}

export class CitiesDTO {
	@ApiProperty()
	_id: string;

	@ApiProperty()
	code_citie: string;

	@ApiProperty()
	name_citie: string;

	@ApiProperty()
	code_region: string;

	@ApiProperty()
	name_region: string;
}

export class UpdatedRegionDTO extends PartialType(CitiesDTO) {}

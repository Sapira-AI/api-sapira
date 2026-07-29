import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class SalesforceDuplicateClientEntitiesQueryDto {
	@ApiPropertyOptional({
		description: 'Número de página',
		example: 1,
		default: 1,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({
		description: 'Cantidad de grupos de tax ID por página',
		example: 50,
		default: 50,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number;
}

export class SalesforceDuplicateClientEntityDto {
	@ApiProperty()
	id: string;

	@ApiProperty({ nullable: true })
	legalName: string | null;

	@ApiProperty({ nullable: true })
	clientId: string | null;

	@ApiProperty({ nullable: true })
	country: string | null;
}

export class SalesforceDuplicateTaxIdGroupDto {
	@ApiProperty()
	taxId: string;

	@ApiProperty()
	count: number;

	@ApiProperty({ type: [SalesforceDuplicateClientEntityDto] })
	entities: SalesforceDuplicateClientEntityDto[];
}

export class SalesforceDuplicateClientEntitiesResponseDto {
	@ApiProperty({ type: [SalesforceDuplicateTaxIdGroupDto] })
	items: SalesforceDuplicateTaxIdGroupDto[];

	@ApiProperty()
	total: number;

	@ApiProperty()
	page: number;

	@ApiProperty()
	limit: number;

	@ApiProperty()
	totalPages: number;
}

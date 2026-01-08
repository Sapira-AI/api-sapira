import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class ListDomainsDto {
	@ApiProperty({
		description: 'ID del holding',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;

	@ApiPropertyOptional({
		description: 'Filtrar solo dominios activos',
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	active_only?: boolean;
}

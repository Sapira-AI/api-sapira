import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class AssignEntityToClientDto {
	@ApiProperty({
		description: 'ID de la razón social (client_entity) a asociar',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	client_entity_id!: string;

	@ApiPropertyOptional({
		description: 'Indica si esta es la razón social principal del cliente',
		example: true,
		default: false,
	})
	@IsBoolean()
	@IsOptional()
	is_primary?: boolean;
}

export class AssignEntityResponseDto {
	@ApiProperty({
		description: 'Indica si la operación fue exitosa',
		example: true,
	})
	success!: boolean;

	@ApiProperty({
		description: 'Mensaje descriptivo del resultado',
		example: 'Razón social asignada exitosamente al cliente',
	})
	message!: string;

	@ApiProperty({
		description: 'ID de la relación creada',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	relation_id!: string;
}

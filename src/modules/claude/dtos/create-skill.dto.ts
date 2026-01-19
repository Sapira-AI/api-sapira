import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateSkillDto {
	@ApiProperty({ description: 'Nombre de la skill' })
	@IsString()
	@IsNotEmpty()
	name: string;

	@ApiProperty({ description: 'Descripción de la skill' })
	@IsString()
	@IsNotEmpty()
	description: string;

	@ApiProperty({ description: 'Schema de entrada de la skill' })
	@IsObject()
	@IsNotEmpty()
	input_schema: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};

	@ApiProperty({ description: 'Holding ID (obligatorio)' })
	@IsString()
	@IsNotEmpty()
	holding_id: string;
}

export class UpdateSkillDto {
	@ApiProperty({ description: 'Holding ID (obligatorio)' })
	@IsString()
	@IsNotEmpty()
	holding_id: string;

	@ApiPropertyOptional({ description: 'Descripción de la skill' })
	@IsString()
	@IsOptional()
	description?: string;

	@ApiPropertyOptional({ description: 'Schema de entrada de la skill' })
	@IsObject()
	@IsOptional()
	input_schema?: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};
}

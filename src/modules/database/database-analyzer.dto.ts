import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AnalyzeTableDTO {
	@ApiProperty({
		description: 'Nombre de la tabla a analizar',
		example: 'integration_logs',
	})
	@IsString()
	table_name!: string;

	@ApiProperty({
		description: 'Esquema de la base de datos',
		example: 'public',
		required: false,
		default: 'public',
	})
	@IsOptional()
	@IsString()
	schema_name?: string;
}

export class ListTablesDTO {
	@ApiProperty({
		description: 'Esquema de la base de datos',
		example: 'public',
		required: false,
		default: 'public',
	})
	@IsOptional()
	@IsString()
	schema_name?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GenerateFromTableDTO {
	@ApiProperty({
		description: 'Nombre de la tabla',
		example: 'contracts',
	})
	@IsString()
	table_name: string;

	@ApiProperty({
		description: 'Esquema de la base de datos',
		example: 'public',
		required: false,
	})
	@IsOptional()
	@IsString()
	schema_name?: string;
}

export class GenerateAllTablesDTO {
	@ApiProperty({
		description: 'Esquema de la base de datos',
		example: 'public',
		required: false,
	})
	@IsOptional()
	@IsString()
	schema_name?: string;
}

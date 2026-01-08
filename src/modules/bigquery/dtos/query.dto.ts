import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class QueryDto {
	@ApiProperty({
		description: 'Consulta SQL para ejecutar en BigQuery',
		example: 'SELECT * FROM `datawarehouse-a2e2.finance.sapira` LIMIT 10',
	})
	@IsString()
	@IsNotEmpty()
	query: string;

	@ApiProperty({
		description: 'Parámetros para la consulta (opcional)',
		example: {},
		required: false,
	})
	@IsOptional()
	params?: Record<string, any>;
}

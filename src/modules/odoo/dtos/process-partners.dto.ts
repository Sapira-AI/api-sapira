import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ProcessPartnersDto {
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;

	@IsString()
	@IsNotEmpty()
	mapping_id: string;

	@IsArray()
	@IsOptional()
	partner_ids?: number[];
}

export class ProcessPartnersResponseDto {
	success: boolean;
	message: string;
	results: {
		total: number;
		success: number;
		errors: number;
		details: Array<{
			odoo_id: number;
			status: 'success' | 'error';
			action?: 'create' | 'update';
			error?: string;
			staging_id?: number;
		}>;
	};
}

export class ClassifyPartnersResponseDto {
	@ApiProperty({
		description: 'Indica si la clasificación fue exitosa',
		example: true,
	})
	success: boolean;

	@ApiProperty({
		description: 'Número de partners nuevos a crear',
		example: 50,
	})
	to_create: number;

	@ApiProperty({
		description: 'Número de partners existentes a actualizar',
		example: 30,
	})
	to_update: number;

	@ApiProperty({
		description: 'Número de partners ya procesados sin cambios',
		example: 20,
	})
	already_processed: number;

	@ApiProperty({
		description: 'Total de partners clasificados',
		example: 100,
	})
	total: number;

	@ApiProperty({
		description: 'Mensaje descriptivo del resultado',
		example: 'Clasificación completada: 50 nuevos, 30 con cambios, 20 ya procesados',
	})
	message: string;
}

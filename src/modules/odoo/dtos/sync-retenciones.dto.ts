import { ApiProperty } from '@nestjs/swagger';

export class SyncRetencionesResponseDto {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message: string;

	@ApiProperty({ description: 'Total de partners procesados' })
	total_partners: number;

	@ApiProperty({ description: 'Cantidad de partners actualizados' })
	updated_count: number;

	@ApiProperty({ description: 'Cantidad de partners omitidos (sin retenciones o sin cambios)' })
	skipped_count: number;

	@ApiProperty({ description: 'Cantidad de errores encontrados' })
	error_count: number;

	@ApiProperty({
		description: 'Lista de errores por partner',
		required: false,
		type: [Object],
	})
	errors?: Array<{ partner_id: number; error: string }>;
}

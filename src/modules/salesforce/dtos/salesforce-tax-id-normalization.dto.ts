import { ApiProperty } from '@nestjs/swagger';

export class SalesforceTaxIdNormalizationResponseDto {
	@ApiProperty({ description: 'ID del holding normalizado' })
	holdingId: string;

	@ApiProperty({ description: 'Cantidad de entidades evaluadas' })
	evaluated: number;

	@ApiProperty({ description: 'Cantidad de tax_id actualizados' })
	normalized: number;

	@ApiProperty({ description: 'Cantidad de entidades sin cambios' })
	unchanged: number;
}

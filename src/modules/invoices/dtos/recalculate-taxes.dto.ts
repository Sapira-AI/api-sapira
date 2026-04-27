import { ApiProperty } from '@nestjs/swagger';

export class RecalculateTaxesResponseDto {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success!: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message!: string;

	@ApiProperty({ description: 'ID de la factura recalculada' })
	invoice_id!: string;

	@ApiProperty({ description: 'Número de items actualizados' })
	items_updated!: number;

	@ApiProperty({ description: 'VAT anterior' })
	old_vat!: number;

	@ApiProperty({ description: 'VAT nuevo (con retenciones)' })
	new_vat!: number;

	@ApiProperty({ description: 'Total anterior' })
	old_total!: number;

	@ApiProperty({ description: 'Total nuevo (con retenciones)' })
	new_total!: number;

	@ApiProperty({ description: 'Retenciones aplicadas', required: false })
	retentions_applied?: {
		reteica?: number;
		retefuente?: number;
		reteiva?: number;
	};
}

export class RecalculateTaxesBatchDto {
	@ApiProperty({ description: 'IDs de las facturas a recalcular', type: [String] })
	invoice_ids!: string[];
}

export class RecalculateTaxesBatchResponseDto {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success!: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message!: string;

	@ApiProperty({ description: 'Número total de facturas procesadas' })
	total_processed!: number;

	@ApiProperty({ description: 'Número de facturas actualizadas exitosamente' })
	successful!: number;

	@ApiProperty({ description: 'Número de facturas con error' })
	failed!: number;

	@ApiProperty({ description: 'Detalles de cada factura procesada' })
	results!: RecalculateTaxesResponseDto[];

	@ApiProperty({ description: 'Errores encontrados', required: false })
	errors?: Array<{ invoice_id: string; error: string }>;
}

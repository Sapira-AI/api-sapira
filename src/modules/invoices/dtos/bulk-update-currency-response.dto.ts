import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MissingExchangeRateDto {
	@ApiProperty({ description: 'Moneda origen', example: 'USD' })
	fromCurrency: string;

	@ApiProperty({ description: 'Moneda destino', example: 'EUR' })
	toCurrency: string;

	@ApiProperty({ description: 'Fecha solicitada', example: '2025-03-05' })
	requestedDate: string;
}

export class FallbackExchangeRateDto {
	@ApiProperty({ description: 'Fecha del tipo de cambio usado', example: '2025-03-03' })
	usedDate: string;

	@ApiProperty({ description: 'Fecha solicitada originalmente', example: '2025-03-05' })
	requestedDate: string;

	@ApiProperty({ description: 'Tipo de cambio aplicado', example: 0.92 })
	rate: number;
}

export class BulkUpdateWarningDto {
	@ApiProperty({ description: 'ID de la factura', example: '123e4567-e89b-12d3-a456-426614174000' })
	invoiceId: string;

	@ApiProperty({ description: 'Número de factura', example: 'INV-001' })
	invoiceNumber: string;

	@ApiProperty({ description: 'Tipo de warning', enum: ['FALLBACK_FX', 'MISSING_FX'] })
	type: 'FALLBACK_FX' | 'MISSING_FX';

	@ApiProperty({ description: 'Mensaje descriptivo del warning' })
	message: string;

	@ApiPropertyOptional({ description: 'Información de tipo de cambio faltante', type: MissingExchangeRateDto })
	missingExchangeRate?: MissingExchangeRateDto;

	@ApiPropertyOptional({ description: 'Información de tipo de cambio fallback usado', type: FallbackExchangeRateDto })
	fallbackExchangeRate?: FallbackExchangeRateDto;
}

export class BulkUpdateErrorDto {
	@ApiProperty({ description: 'ID de la factura', example: '123e4567-e89b-12d3-a456-426614174000' })
	invoiceId: string;

	@ApiProperty({ description: 'Número de factura', example: 'INV-001' })
	invoiceNumber: string;

	@ApiProperty({ description: 'Mensaje de error' })
	error: string;
}

export class BulkUpdateSummaryDto {
	@ApiProperty({ description: 'Facturas con FX calculado automáticamente', example: 3 })
	withAutomaticFx: number;

	@ApiProperty({ description: 'Facturas con FX de fallback', example: 1 })
	withFallbackFx: number;

	@ApiProperty({ description: 'Facturas sin FX (requieren ingreso manual)', example: 1 })
	withoutFx: number;

	@ApiProperty({ description: 'Facturas con misma moneda del contrato', example: 2 })
	sameCurrency: number;
}

export class BulkUpdateCurrencyResponseDto {
	@ApiProperty({ description: 'Indica si la operación fue exitosa', example: true })
	success: boolean;

	@ApiProperty({ description: 'Número de facturas actualizadas', example: 5 })
	updatedCount: number;

	@ApiProperty({ description: 'Número total de facturas solicitadas', example: 5 })
	totalRequested: number;

	@ApiProperty({ description: 'Indica si fue una simulación (dryRun)', example: false })
	dryRun: boolean;

	@ApiProperty({ description: 'Resumen de la actualización', type: BulkUpdateSummaryDto })
	summary: BulkUpdateSummaryDto;

	@ApiProperty({ description: 'Warnings generados durante la actualización', type: [BulkUpdateWarningDto] })
	warnings: BulkUpdateWarningDto[];

	@ApiProperty({ description: 'Errores encontrados durante la actualización', type: [BulkUpdateErrorDto] })
	errors: BulkUpdateErrorDto[];
}

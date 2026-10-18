import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Una factura previa a adoptar y los meses del contrato que cubre (por defecto, el mes de emisión). Varios meses = la previa cubre
 * varias Por Emitir (p. ej. una factura trimestral); el neto se reparte en proporción al neto de cada destino.
 */
export class AdoptPreviousInvoiceItemDto {
	@ApiProperty({ format: 'uuid' })
	@IsUUID()
	invoice_id!: string;

	@ApiPropertyOptional({ example: ['2026-04', '2026-05'], description: 'Meses del contrato que cubre (YYYY-MM). Por defecto, el mes de emisión.' })
	@IsOptional()
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(24)
	@Matches(MONTH, { each: true })
	months?: string[];

	@ApiPropertyOptional({
		default: false,
		description:
			'Cobertura parcial: si la previa cubre menos que la Por Emitir, el resto queda como una Por Emitir nueva (remanente). Sin esto, la Por Emitir se reemplaza completa por el neto de la previa.',
	})
	@IsOptional()
	@IsBoolean()
	keep_remainder?: boolean;
}

/** Vista previa: `contract_id` opcional (sin él, la respuesta trae los contratos candidatos del cliente y ningún destino). */
export class AdoptPreviousInvoicesPreviewDto {
	@ApiPropertyOptional({ format: 'uuid' })
	@IsOptional()
	@IsUUID()
	contract_id?: string;

	@ApiProperty({ type: [AdoptPreviousInvoiceItemDto] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(50)
	@ValidateNested({ each: true })
	@Type(() => AdoptPreviousInvoiceItemDto)
	invoices!: AdoptPreviousInvoiceItemDto[];
}

/** Aplicar: contrato obligatorio. Todo o nada: si una factura tiene bloqueos, no se adopta ninguna. */
export class AdoptPreviousInvoicesDto {
	@ApiProperty({ format: 'uuid' })
	@IsUUID()
	contract_id!: string;

	@ApiProperty({ type: [AdoptPreviousInvoiceItemDto] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(50)
	@ValidateNested({ each: true })
	@Type(() => AdoptPreviousInvoiceItemDto)
	invoices!: AdoptPreviousInvoiceItemDto[];

	@ApiPropertyOptional({ maxLength: 500 })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	notes?: string;
}

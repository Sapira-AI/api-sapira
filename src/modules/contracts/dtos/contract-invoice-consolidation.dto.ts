import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { CONSOLIDATION_MAX_INVOICES, CONSOLIDATION_MIN_INVOICES, CONSOLIDATION_NOTES_MAX } from '../invoice-consolidation';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `POST /contracts/invoices/consolidations/preview` y `POST /contracts/invoices/consolidations` (spec multimoneda §7). */
export class ConsolidateInvoicesDto {
	@ApiProperty({
		type: [String],
		description: `Facturas Por Emitir de 2 o más contratos (${CONSOLIDATION_MIN_INVOICES}–${CONSOLIDATION_MAX_INVOICES})`,
		minItems: CONSOLIDATION_MIN_INVOICES,
		maxItems: CONSOLIDATION_MAX_INVOICES,
	})
	@IsArray({ message: 'invoice_ids debe ser una lista' })
	@ArrayMinSize(CONSOLIDATION_MIN_INVOICES, { message: `Elige al menos ${CONSOLIDATION_MIN_INVOICES} facturas` })
	@ArrayMaxSize(CONSOLIDATION_MAX_INVOICES, { message: `Máximo ${CONSOLIDATION_MAX_INVOICES} facturas` })
	@ArrayUnique({ message: 'Hay facturas repetidas' })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];

	@ApiPropertyOptional({ description: 'Notas del documento consolidado', maxLength: CONSOLIDATION_NOTES_MAX })
	@IsOptional()
	@Transform(trim)
	@IsString({ message: 'Las notas deben ser texto' })
	@MaxLength(CONSOLIDATION_NOTES_MAX, { message: `Las notas no pueden superar ${CONSOLIDATION_NOTES_MAX} caracteres` })
	notes?: string;
}

/** `POST /contracts/invoices/consolidations/:invoiceId/undo`. */
export class UndoConsolidationDto {
	@ApiProperty({ description: 'Motivo de deshacer la consolidación', maxLength: CONSOLIDATION_NOTES_MAX })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@Matches(/\S/, { message: 'Escribe el motivo' })
	@MaxLength(CONSOLIDATION_NOTES_MAX, { message: `El motivo no puede superar ${CONSOLIDATION_NOTES_MAX} caracteres` })
	reason!: string;
}

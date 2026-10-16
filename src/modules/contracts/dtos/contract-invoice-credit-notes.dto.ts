import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsNumber,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { DISCOUNT_CREDIT_REASONS, type DiscountCreditReason, VOID_REASONS, type VoidReason } from '../invoice-void';
import { ONE_OFF_REVENUE_TREATMENTS, type OneOffRevenueTreatment } from '../one-off-discount';

import { EDIT_LINES_MAX, EditInvoiceDto, NOTES_MAX } from './contract-invoice-edit.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const FOLIO_MAX = 100;

/**
 * Folio y fecha de la NC cuando ya se emitió a mano en el ERP o el holding no tiene ERP (Domi 12-10). Opcionales al anular o descontar: sin
 * folio, la NC queda pendiente de emisión electrónica; con folio, nace registrada.
 */
class CreditNoteDocumentFields {
	@ApiPropertyOptional({ description: 'Folio de la NC emitida en el ERP o fuera de él (opcional)', maxLength: FOLIO_MAX })
	@Transform(trim)
	@ValidateIf((_dto: CreditNoteDocumentFields, value: unknown) => present(value) && value !== '')
	@IsString({ message: 'El folio debe ser texto' })
	@MaxLength(FOLIO_MAX, { message: `El folio no puede superar ${FOLIO_MAX} caracteres` })
	credit_note_number?: string | null;

	@ApiPropertyOptional({ description: 'Fecha de emisión de la NC (YYYY-MM-DD); sin valor = hoy' })
	@ValidateIf((_dto: CreditNoteDocumentFields, value: unknown) => present(value) && value !== '')
	@Matches(ISO_DAY, { message: 'La fecha de la nota de crédito debe tener la forma YYYY-MM-DD' })
	credit_note_issue_date?: string | null;
}

/** `POST …/:invoiceId/void/preview` y `POST …/:invoiceId/void` (spec facturas §3.8). */
export class VoidInvoiceDto extends CreditNoteDocumentFields {
	@ApiProperty({
		enum: VOID_REASONS,
		description:
			'issue_error (error de emisión) · client_request (solicitud del cliente; la NC guarda credit_reason = other) · other. Va al evento y a las notas de la NC',
	})
	@IsIn(VOID_REASONS, { message: 'Motivo inválido: issue_error, client_request u other' })
	reason!: VoidReason;

	@ApiPropertyOptional({ description: 'Notas (van a la NC y al evento)', maxLength: NOTES_MAX })
	@Transform(trim)
	@ValidateIf((_dto: VoidInvoiceDto, value: unknown) => present(value))
	@IsString({ message: 'Las notas deben ser texto' })
	@MaxLength(NOTES_MAX, { message: `Las notas no pueden superar ${NOTES_MAX} caracteres` })
	notes?: string | null;

	@ApiProperty({ description: 'true = además de la NC espejo, crea una Por Emitir nueva del período que reemplaza a la anulada' })
	@IsBoolean({ message: 'Indica si se reemite (reissue: true o false)' })
	reissue!: boolean;

	@ApiPropertyOptional({
		type: EditInvoiceDto,
		description:
			'Solo con reissue: cambios a la reemisión con el mismo cuerpo del editor (`PUT …/:invoiceId`, §3.4). `lines[].id` son las líneas de la EMITIDA; sin cambios = copia exacta',
	})
	@ValidateIf((_dto: VoidInvoiceDto, value: unknown) => present(value))
	@ValidateNested()
	@Type(() => EditInvoiceDto)
	reissue_changes?: EditInvoiceDto | null;
}

/** Una línea de la NC de descuento: monto (moneda de factura) o porcentaje del neto de la línea. */
export class DiscountCreditNoteLineDto {
	@ApiProperty({ description: 'Línea de la factura emitida' })
	@IsUUID(undefined, { message: 'Línea inválida' })
	line_id!: string;

	@ApiPropertyOptional({ description: 'Descuento neto en MONEDA DE FACTURA (la del documento); uno de amount o pct' })
	@ValidateIf((_dto: DiscountCreditNoteLineDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto inválido' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount?: number | null;

	@ApiPropertyOptional({ description: 'Porcentaje del neto original de la línea (0–100]; uno de amount o pct' })
	@ValidateIf((_dto: DiscountCreditNoteLineDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Porcentaje inválido' })
	@Min(0.000001, { message: 'El porcentaje debe ser mayor que 0' })
	@Max(100, { message: 'El porcentaje no puede superar 100' })
	pct?: number | null;
}

/** `POST …/:invoiceId/credit-note/preview` y `POST …/:invoiceId/credit-note`: NC de descuento parcial sobre una emitida. */
export class DiscountCreditNoteDto extends CreditNoteDocumentFields {
	@ApiPropertyOptional({ type: [DiscountCreditNoteLineDto], description: 'Líneas a descontar (o `pct` para todas las líneas con monto)' })
	@IsOptional()
	@IsArray({ message: 'lines debe ser una lista' })
	@ArrayMinSize(1, { message: 'Indica al menos una línea' })
	@ArrayMaxSize(EDIT_LINES_MAX, { message: `Máximo ${EDIT_LINES_MAX} líneas` })
	@ValidateNested({ each: true })
	@Type(() => DiscountCreditNoteLineDto)
	lines?: DiscountCreditNoteLineDto[];

	@ApiPropertyOptional({ description: 'Porcentaje sobre todas las líneas con monto (en vez de `lines`)' })
	@ValidateIf((_dto: DiscountCreditNoteDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Porcentaje inválido' })
	@Min(0.000001, { message: 'El porcentaje debe ser mayor que 0' })
	@Max(100, { message: 'El porcentaje no puede superar 100' })
	pct?: number | null;

	@ApiProperty({
		enum: DISCOUNT_CREDIT_REASONS,
		description: 'Motivo (credit_reason): prompt_payment_discount · one_time_discount · compensation · other',
	})
	@IsIn(DISCOUNT_CREDIT_REASONS, { message: 'Motivo inválido: prompt_payment_discount, one_time_discount, compensation u other' })
	reason!: DiscountCreditReason;

	@ApiProperty({
		enum: ONE_OFF_REVENUE_TREATMENTS,
		description:
			'Devengo del descuento (nc_revenue_treatment): service_period (meses del período de servicio) · impact_month (mes de la NC) · defer_forward (desde el mes de la NC hasta el fin del ítem)',
	})
	@IsIn(ONE_OFF_REVENUE_TREATMENTS, { message: 'revenue_treatment inválido: service_period, impact_month o defer_forward' })
	revenue_treatment!: OneOffRevenueTreatment;

	@ApiPropertyOptional({ description: 'Notas (van a la NC y al evento)', maxLength: NOTES_MAX })
	@Transform(trim)
	@ValidateIf((_dto: DiscountCreditNoteDto, value: unknown) => present(value))
	@IsString({ message: 'Las notas deben ser texto' })
	@Matches(/\S/, { message: 'Las notas no pueden quedar vacías' })
	@MaxLength(NOTES_MAX, { message: `Las notas no pueden superar ${NOTES_MAX} caracteres` })
	notes?: string | null;
}

/** `POST …/:invoiceId/credit-note-folio`: folio (y fecha) de una NC pendiente de emisión, emitida después a mano (Domi 12-10). */
export class RegisterCreditNoteFolioDto {
	@ApiProperty({ description: 'Folio de la NC emitida', maxLength: FOLIO_MAX })
	@Transform(trim)
	@IsString({ message: 'Escribe el folio de la nota de crédito' })
	@MaxLength(FOLIO_MAX, { message: `El folio no puede superar ${FOLIO_MAX} caracteres` })
	@Matches(/\S/, { message: 'Escribe el folio de la nota de crédito' })
	invoice_number!: string;

	@ApiPropertyOptional({ description: 'Fecha de emisión de la NC (YYYY-MM-DD); sin valor = la que tiene' })
	@ValidateIf((_dto: RegisterCreditNoteFolioDto, value: unknown) => present(value) && value !== '')
	@Matches(ISO_DAY, { message: 'La fecha de la nota de crédito debe tener la forma YYYY-MM-DD' })
	issue_date?: string | null;
}

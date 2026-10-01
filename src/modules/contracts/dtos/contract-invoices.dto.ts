import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsIn,
	IsInt,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
} from 'class-validator';

import { INVOICE_FX_POLICIES, type InvoiceFxPolicy, type RescheduleApplyTo } from '../contract-invoices';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

export const INVOICE_IDS_MAX = 200;
export const RESCHEDULE_APPLY_TO = ['this', 'this_and_following'] as const;

/** Motivo y notas opcionales, comunes a las operaciones sobre facturas: van al evento (`metadata.reason`, `metadata.notes`). */
export class InvoiceOperationDto {
	@ApiPropertyOptional({ description: 'Motivo (queda en el evento)', maxLength: 500 })
	@Transform(trim)
	@IsString()
	@MaxLength(500, { message: 'El motivo no puede superar 500 caracteres' })
	@IsOptional()
	reason?: string;

	@ApiPropertyOptional({ description: 'Notas (quedan en el evento)', maxLength: 2000 })
	@Transform(trim)
	@IsString()
	@MaxLength(2000, { message: 'Las notas no pueden superar 2000 caracteres' })
	@IsOptional()
	notes?: string;
}

/** `POST /contracts/:id/invoices/:invoiceId/send-now` (spec §3.1): sin cuerpo obligatorio. */
export class SendInvoiceNowDto extends InvoiceOperationDto {}

/** `POST /contracts/:id/invoices/:invoiceId/mark-issued` (spec §3.1, S4-14). */
export class MarkInvoiceIssuedDto extends InvoiceOperationDto {
	@ApiProperty({ description: 'Folio o número real del documento emitido' })
	@Transform(trim)
	@IsString({ message: 'Escribe el folio de la factura emitida' })
	@MaxLength(100, { message: 'El folio no puede superar 100 caracteres' })
	@Matches(/\S/, { message: 'Escribe el folio de la factura emitida' })
	invoice_number!: string;

	@ApiProperty({ description: 'Fecha de emisión real (YYYY-MM-DD)' })
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date!: string;

	@ApiPropertyOptional({ description: 'Tasa usada en la emisión (1 moneda de contrato = X moneda de factura); solo multimoneda spot sin tasa' })
	@ValidateIf((_dto: MarkInvoiceIssuedDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Tasa inválida' })
	@Min(0.000001, { message: 'La tasa debe ser mayor que 0' })
	fx_rate?: number;
}

/** `POST /contracts/:id/invoices/:invoiceId/reschedule` (spec §3.3). */
export class RescheduleInvoiceDto extends InvoiceOperationDto {
	@ApiProperty({ description: 'Nueva fecha de emisión (YYYY-MM-DD)' })
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date!: string;

	@ApiPropertyOptional({
		enum: RESCHEDULE_APPLY_TO,
		default: 'this',
		description: 'this_and_following lleva también las Por Emitir posteriores al mismo día del mes elegido (recortado al fin de mes)',
	})
	@IsIn(RESCHEDULE_APPLY_TO, { message: 'apply_to inválido: this o this_and_following' })
	@IsOptional()
	apply_to?: RescheduleApplyTo;
}

/** `POST /contracts/:id/invoices/reschedule-bulk` (spec §3.3, "mover al mes siguiente"): `shift_months` o `issue_date`, no ambos. */
export class RescheduleInvoicesBulkDto extends InvoiceOperationDto {
	@ApiProperty({ type: [String], description: 'Facturas Por Emitir del contrato' })
	@IsArray({ message: 'Indica las facturas a reprogramar' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];

	@ApiPropertyOptional({ description: 'Meses a correr (1–12); excluyente con issue_date', minimum: 1, maximum: 12 })
	@ValidateIf((dto: RescheduleInvoicesBulkDto) => !dto.issue_date)
	@IsInt({ message: 'Indica cuántos meses correr (1–12) o una fecha de emisión' })
	@Min(1, { message: 'Corre al menos 1 mes' })
	@Max(12, { message: 'Máximo 12 meses' })
	shift_months?: number;

	@ApiPropertyOptional({ description: 'Fecha de emisión para todas (YYYY-MM-DD); excluyente con shift_months' })
	@ValidateIf((dto: RescheduleInvoicesBulkDto) => !present(dto.shift_months))
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date?: string;
}

/** `POST /contracts/:id/invoices/:invoiceId/fx` (spec §3.2). */
export class InvoiceFxDto extends InvoiceOperationDto {
	@ApiProperty({
		enum: INVOICE_FX_POLICIES,
		description: 'spot (se valoriza al emitir) · fixed (tasa) · net_exact (neto exacto en moneda de factura, caso OC)',
	})
	@IsIn(INVOICE_FX_POLICIES, { message: 'Política inválida: spot, fixed o net_exact' })
	policy!: InvoiceFxPolicy;

	@ApiPropertyOptional({ description: 'Tasa fija: 1 moneda de contrato = rate moneda de factura (obligatoria con fixed)' })
	@ValidateIf((dto: InvoiceFxDto) => (dto.policy === 'fixed' && !dto.rates_by_pair) || present(dto.rate))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la tasa fija' })
	@Min(0.000001, { message: 'El tipo de cambio fijo debe ser mayor que 0' })
	rate?: number;

	@ApiPropertyOptional({ description: 'Neto exacto en moneda de factura (obligatorio con net_exact; una factura a la vez)' })
	@ValidateIf((dto: InvoiceFxDto) => dto.policy === 'net_exact' || present(dto.target_net_amount))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el neto exacto en moneda de factura' })
	@Min(0.01, { message: 'El neto exacto debe ser mayor que 0' })
	target_net_amount?: number;
	@ApiPropertyOptional({
		type: 'object',
		additionalProperties: { type: 'number' },
		example: { 'USD>CLP': 950.5, 'CLF>CLP': 39000 },
		description:
			'Multimoneda (contrato con ítems en distintas monedas): tasa fija por par moneda del ítem > moneda de factura (1 USD = 950,5 CLP). Con un solo par basta `rate`. `net_exact` solo con un par (400 net_exact_multi_pair)',
	})
	@IsObject({ message: 'rates_by_pair debe ser un objeto { "USD>CLP": tasa }' })
	@IsOptional()
	rates_by_pair?: Record<string, number>;
}

/** `POST /contracts/:id/invoices/fx-bulk` (spec §3.2): varias facturas a spot o a una misma tasa fija (`net_exact` es de una sola). */
export class InvoiceFxBulkDto extends InvoiceOperationDto {
	@ApiProperty({ type: [String], description: 'Facturas Por Emitir del contrato' })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];

	@ApiProperty({ enum: INVOICE_FX_POLICIES })
	@IsIn(INVOICE_FX_POLICIES, { message: 'Política inválida: spot, fixed o net_exact' })
	policy!: InvoiceFxPolicy;

	@ApiPropertyOptional({ description: 'Tasa fija (obligatoria con fixed)' })
	@ValidateIf((dto: InvoiceFxBulkDto) => (dto.policy === 'fixed' && !dto.rates_by_pair) || present(dto.rate))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la tasa fija' })
	@Min(0.000001, { message: 'El tipo de cambio fijo debe ser mayor que 0' })
	rate?: number;

	@ApiPropertyOptional({ description: 'Neto exacto (solo con net_exact y una sola factura)' })
	@ValidateIf((dto: InvoiceFxBulkDto) => dto.policy === 'net_exact' || present(dto.target_net_amount))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el neto exacto en moneda de factura' })
	@Min(0.01, { message: 'El neto exacto debe ser mayor que 0' })
	target_net_amount?: number;
	@ApiPropertyOptional({
		type: 'object',
		additionalProperties: { type: 'number' },
		example: { 'USD>CLP': 950.5 },
		description: 'Multimoneda: tasa fija por par (`USD>CLP`) para todas las facturas',
	})
	@IsObject({ message: 'rates_by_pair debe ser un objeto { "USD>CLP": tasa }' })
	@IsOptional()
	rates_by_pair?: Record<string, number>;
}

/** `POST /contracts/:id/invoices/:invoiceId/erp-reset` (§3.1): restablecer el borrador del ERP de una Por Emitir. */
export class ErpResetInvoiceDto extends InvoiceOperationDto {}

/** `POST /contracts/:id/invoices/erp-reset`: varias Por Emitir; las bloqueadas se informan en `skipped`. */
export class ErpResetInvoicesBulkDto extends InvoiceOperationDto {
	@ApiProperty({ type: [String], description: 'Facturas Por Emitir del contrato vinculadas al ERP' })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];
}

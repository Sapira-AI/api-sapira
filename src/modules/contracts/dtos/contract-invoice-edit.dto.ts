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
	ValidateBy,
	ValidateIf,
	ValidateNested,
	type ValidationArguments,
	type ValidationOptions,
} from 'class-validator';

import { AMOUNT_BASES, type AmountBasis, DEVIATION_TYPES, type DeviationType, LINE_MODE_SCOPES, type LineModeScope } from '../invoice-edit';
import { ONE_OFF_DISCOUNT_TYPES, ONE_OFF_REVENUE_TREATMENTS, type OneOffDiscountType, type OneOffRevenueTreatment } from '../one-off-discount';
import { INVOICE_LINE_MODES, type InvoiceLineMode } from '../pricing-engine';

import { INVOICE_IDS_MAX } from './contract-invoices.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

export const EDIT_LINES_MAX = 200;
export const DESCRIPTION_MAX = 1000;
export const TERMS_MAX = 5000;
export const NOTES_MAX = 2000;
export const DEVIATION_REASON_MAX = 500;

/**
 * Tope solo para el descuento puntual en %: `@ValidateIf` sobre la propiedad apagaba TODAS sus validaciones (`IsNumber`, `Min`) cuando el
 * tipo era `amount`; este validador condiciona solo el máximo.
 */
const MaxWhenPct = (max: number, options?: ValidationOptions) =>
	ValidateBy(
		{
			name: 'maxWhenPct',
			validator: {
				validate: (value: unknown, args?: ValidationArguments) =>
					(args?.object as { type?: string } | undefined)?.type !== 'pct' || (typeof value === 'number' && value <= max),
			},
		},
		options
	);

/** Descuento puntual de una línea (solo esta factura): % del subtotal de la línea o monto en moneda de contrato. */
export class OneOffDiscountDto {
	@ApiProperty({ enum: ONE_OFF_DISCOUNT_TYPES, description: 'pct = porcentaje del subtotal de la línea · amount = monto en moneda de contrato' })
	@IsIn(ONE_OFF_DISCOUNT_TYPES, { message: 'Tipo de descuento puntual inválido: pct o amount' })
	type!: OneOffDiscountType;

	@ApiProperty({ description: 'Valor (> 0; con pct, hasta 100)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Valor del descuento puntual inválido' })
	@Min(0, { message: 'El descuento puntual no puede ser negativo' })
	@MaxWhenPct(100, { message: 'El descuento puntual en % no puede superar 100' })
	value!: number;
}

/** Una línea del editor (spec facturas §3.4). Con `id` actualiza esa línea; sin `id` es nueva y debe ser de un ítem vigente del contrato. */
export class EditInvoiceLineDto {
	@ApiPropertyOptional({ description: 'Línea existente de la factura; sin id = línea nueva' })
	@ValidateIf((_dto: EditInvoiceLineDto, value: unknown) => present(value))
	@IsUUID(undefined, { message: 'Línea inválida' })
	id?: string | null;

	@ApiProperty({ description: 'Ítem del contrato (obligatorio siempre: no hay líneas informativas)' })
	@IsUUID(undefined, { message: 'Indica el ítem del contrato de la línea' })
	contract_item_id!: string;

	@ApiPropertyOptional({
		description: 'Glosa escrita a mano (queda protegida: description_locked). Sin valor = se conserva o se regenera con la plantilla',
	})
	@Transform(trim)
	@ValidateIf((_dto: EditInvoiceLineDto, value: unknown) => present(value))
	@IsString({ message: 'La descripción debe ser texto' })
	@Matches(/\S/, { message: 'La descripción no puede quedar vacía' })
	@MaxLength(DESCRIPTION_MAX, { message: `La descripción no puede superar ${DESCRIPTION_MAX} caracteres` })
	description?: string | null;

	@ApiProperty({ description: 'Cantidad (0 = línea oculta: queda en Sapira con monto 0, no viaja al documento)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Cantidad inválida' })
	quantity!: number;

	@ApiProperty({ description: 'Unitario en MONEDA DE CONTRATO (en líneas con modelo de precio, el unitario efectivo)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Precio unitario inválido' })
	@Min(0, { message: 'El precio unitario no puede ser negativo: un descuento puntual va en discount_pct' })
	unit_price!: number;

	@ApiPropertyOptional({
		description:
			'Descuento de la línea (0–100). En líneas con modelo de precio el descuento del ítem ya está dentro del unitario: el valor es un descuento ADICIONAL (omitido o igual al guardado = sin adicional)',
	})
	@ValidateIf((_dto: EditInvoiceLineDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Descuento inválido' })
	@Min(0, { message: 'El descuento debe estar entre 0 y 100' })
	@Max(100, { message: 'El descuento debe estar entre 0 y 100' })
	discount_pct?: number | null;

	@ApiProperty({ description: 'Inicio del período de servicio (YYYY-MM-DD)' })
	@Matches(ISO_DATE, { message: 'El inicio del período debe tener la forma YYYY-MM-DD' })
	billing_period_start!: string;

	@ApiProperty({ description: 'Fin del período de servicio (YYYY-MM-DD)' })
	@Matches(ISO_DATE, { message: 'El fin del período debe tener la forma YYYY-MM-DD' })
	billing_period_end!: string;

	@ApiPropertyOptional({
		enum: AMOUNT_BASES,
		default: 'unit_rate',
		description: 'unit_rate: cantidad × unitario × (1 − descuento) · exact_total: subtotal fijo, unitario derivado',
	})
	@ValidateIf((_dto: EditInvoiceLineDto, value: unknown) => present(value))
	@IsIn(AMOUNT_BASES, { message: 'amount_basis inválido: unit_rate o exact_total' })
	amount_basis?: AmountBasis | null;

	@ApiPropertyOptional({ description: 'Subtotal neto exacto en moneda de contrato (obligatorio con exact_total)' })
	@ValidateIf((dto: EditInvoiceLineDto) => dto.amount_basis === 'exact_total' || present(dto.exact_total))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el subtotal exacto de la línea' })
	@Min(0, { message: 'El subtotal exacto no puede ser negativo' })
	exact_total?: number | null;

	@ApiPropertyOptional({
		type: OneOffDiscountDto,
		nullable: true,
		description:
			'Descuento puntual de esta factura: la línea conserva cantidad × unitario y su discount_pct pasa a ser el % efectivo combinado; queda como sublínea { kind: discount, one_off: true } del pricing_breakdown. Ausente = se conserva; null = se quita. Exige deviation { type: discount, reason, revenue_treatment }',
	})
	@ValidateIf((_dto: EditInvoiceLineDto, value: unknown) => present(value))
	@ValidateNested()
	@Type(() => OneOffDiscountDto)
	one_off_discount?: OneOffDiscountDto | null;
}

/** Presentación de un ítem con modelo de precio: una fila por tramo o una sola fila (sin cambiar el total). */
export class InvoiceLineModeDto {
	@ApiProperty({ description: 'Ítem del contrato con modelo de precio' })
	@IsUUID(undefined, { message: 'Ítem inválido' })
	contract_item_id!: string;

	@ApiProperty({ enum: INVOICE_LINE_MODES, description: 'single = una fila con el detalle en la glosa · per_tier = una fila por tramo' })
	@IsIn(INVOICE_LINE_MODES, { message: 'mode inválido: single o per_tier' })
	mode!: InvoiceLineMode;

	@ApiPropertyOptional({
		enum: LINE_MODE_SCOPES,
		default: 'invoice',
		description: 'invoice = solo esta factura · invoice_and_following = también el precio del contrato y las Por Emitir siguientes',
	})
	@ValidateIf((_dto: InvoiceLineModeDto, value: unknown) => present(value))
	@IsIn(LINE_MODE_SCOPES, { message: 'scope inválido: invoice o invoice_and_following' })
	scope?: LineModeScope | null;
}

/** Motivo tipado del desvío contra el plan (se guarda en `invoice_adjustments`). */
export class InvoiceDeviationDto {
	@ApiProperty({ enum: DEVIATION_TYPES, description: 'discount (descuento puntual) · upsell · downsell · correction' })
	@IsIn(DEVIATION_TYPES, { message: 'Tipo de desvío inválido: discount, upsell, downsell o correction' })
	type!: DeviationType;

	@ApiProperty({ description: 'Motivo (obligatorio)', maxLength: DEVIATION_REASON_MAX })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo del desvío' })
	@Matches(/\S/, { message: 'Escribe el motivo del desvío' })
	@MaxLength(DEVIATION_REASON_MAX, { message: `El motivo no puede superar ${DEVIATION_REASON_MAX} caracteres` })
	reason!: string;

	@ApiPropertyOptional({
		enum: ONE_OFF_REVENUE_TREATMENTS,
		description:
			'Devengo del descuento puntual (obligatorio si la edición agrega o cambia uno): service_period (meses del período de servicio) · impact_month (mes de emisión) · defer_forward (desde el mes de emisión hasta el fin del ítem)',
	})
	@ValidateIf((_dto: InvoiceDeviationDto, value: unknown) => present(value))
	@IsIn(ONE_OFF_REVENUE_TREATMENTS, { message: 'revenue_treatment inválido: service_period, impact_month o defer_forward' })
	revenue_treatment?: OneOffRevenueTreatment | null;
}

/** `POST …/:invoiceId/edit/preview` y `PUT …/:invoiceId` (spec facturas §3.4). */
export class EditInvoiceDto {
	@ApiPropertyOptional({
		type: [EditInvoiceLineDto],
		description: 'Líneas a cambiar o agregar; las líneas no enviadas quedan SIN CAMBIOS (nada se borra)',
	})
	@IsOptional()
	@IsArray({ message: 'lines debe ser una lista' })
	@ArrayMaxSize(EDIT_LINES_MAX, { message: `Máximo ${EDIT_LINES_MAX} líneas por edición` })
	@ValidateNested({ each: true })
	@Type(() => EditInvoiceLineDto)
	lines?: EditInvoiceLineDto[];

	@ApiPropertyOptional({ type: [InvoiceLineModeDto], description: 'Presentación por tramo ↔ una fila de ítems con modelo de precio' })
	@IsOptional()
	@IsArray({ message: 'line_mode debe ser una lista' })
	@ArrayMaxSize(50, { message: 'Máximo 50 ítems por edición' })
	@ValidateNested({ each: true })
	@Type(() => InvoiceLineModeDto)
	line_mode?: InvoiceLineModeDto[];

	@ApiPropertyOptional({ description: 'Nueva fecha de emisión (YYYY-MM-DD); conserva original_issue_date y recalcula el vencimiento' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date?: string | null;

	@ApiPropertyOptional({ description: 'Vencimiento (YYYY-MM-DD); sin valor se calcula por la condición de pago' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'El vencimiento debe tener la forma YYYY-MM-DD' })
	due_date?: string | null;

	@ApiPropertyOptional({ description: 'Receptor: razón social del cliente del contrato (re-deriva RUT, IVA y exportación)' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@IsUUID(undefined, { message: 'Razón social inválida' })
	client_entity_id?: string | null;

	@ApiPropertyOptional({ description: 'Términos y condiciones de la factura (null = sin términos)' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@IsString({ message: 'Los términos deben ser texto' })
	@MaxLength(TERMS_MAX, { message: `Los términos no pueden superar ${TERMS_MAX} caracteres` })
	invoice_terms_and_conditions?: string | null;

	@ApiPropertyOptional({ description: 'Notas de la factura (reemplazan las actuales; null = sin notas)' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@IsString({ message: 'Las notas deben ser texto' })
	@MaxLength(NOTES_MAX, { message: `Las notas no pueden superar ${NOTES_MAX} caracteres` })
	notes?: string | null;

	@ApiPropertyOptional({ description: 'Emisión automática al enviar al ERP' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@IsBoolean({ message: 'auto_invoice debe ser verdadero o falso' })
	auto_invoice?: boolean | null;

	@ApiPropertyOptional({
		type: InvoiceDeviationDto,
		description: 'Motivo del desvío contra el plan (obligatorio al aplicar si la edición lo introduce o cambia)',
	})
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@ValidateNested()
	@Type(() => InvoiceDeviationDto)
	deviation?: InvoiceDeviationDto | null;

	@ApiPropertyOptional({ description: 'Recomponer también filas editadas a mano al cambiar la presentación por tramo' })
	@ValidateIf((_dto: EditInvoiceDto, value: unknown) => present(value))
	@IsBoolean({ message: 'confirm_manual_overwrite debe ser verdadero o falso' })
	confirm_manual_overwrite?: boolean | null;
}

/** `POST …/:invoiceId/deviation`: motivo de un desvío heredado. */
export class ExplainInvoiceDeviationDto extends InvoiceDeviationDto {}

/** `POST …/invoices/bulk-edit/preview` y `PATCH …/invoices/bulk-edit`: cambios de encabezado en varias Por Emitir. */
export class BulkEditInvoicesDto {
	@ApiProperty({ type: [String], description: 'Facturas Por Emitir del contrato' })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMinSize(1, { message: 'Indica al menos una factura' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids!: string[];

	@ApiPropertyOptional({ description: 'Términos y condiciones (null = sin términos)' })
	@ValidateIf((_dto: BulkEditInvoicesDto, value: unknown) => present(value))
	@IsString({ message: 'Los términos deben ser texto' })
	@MaxLength(TERMS_MAX, { message: `Los términos no pueden superar ${TERMS_MAX} caracteres` })
	invoice_terms_and_conditions?: string | null;

	@ApiPropertyOptional({ description: 'Receptor: razón social del cliente del contrato' })
	@ValidateIf((_dto: BulkEditInvoicesDto, value: unknown) => present(value))
	@IsUUID(undefined, { message: 'Razón social inválida' })
	client_entity_id?: string;

	@ApiPropertyOptional({ description: 'Emisión automática al enviar al ERP' })
	@ValidateIf((_dto: BulkEditInvoicesDto, value: unknown) => present(value))
	@IsBoolean({ message: 'auto_invoice debe ser verdadero o falso' })
	auto_invoice?: boolean;
}

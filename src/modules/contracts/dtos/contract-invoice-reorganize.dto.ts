import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsIn,
	IsInt,
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

import { REORGANIZE_MAX_PARTS, REORGANIZE_OPS, type ReorganizeOp, SPLIT_LINE_BY, type SplitLineBy } from '../invoice-reorganize';

import { InvoiceDeviationDto } from './contract-invoice-edit.dto';
import { INVOICE_IDS_MAX } from './contract-invoices.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

export const REORGANIZE_OPERATIONS_MAX = 50;
export const REORGANIZE_REASON_MAX = 500;

const LINE_OPS: ReorganizeOp[] = ['move_line', 'split_line'];
const ITEM_OPS: ReorganizeOp[] = ['item_monthly', 'item_unify_pending', 'item_even_split'];
const INVOICE_OPS: ReorganizeOp[] = ['split_invoice', 'round_fix'];

/** Fecha de emisión de la factura nueva que recibe una línea (`move_line`). */
export class ReorganizeNewInvoiceDto {
	@ApiProperty({ description: 'Fecha de emisión (YYYY-MM-DD); el resto del encabezado sale de las reglas del generador' })
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date!: string;
}

/** Una cuota de `split_line` por `installments`: monto (moneda de contrato) y fecha de emisión opcional. */
export class ReorganizeInstallmentDto {
	@ApiProperty({ description: 'Monto de la cuota en moneda de contrato (> 0)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto de cuota inválido' })
	@Min(0.01, { message: 'Cada cuota debe ser mayor que 0' })
	amount!: number;

	@ApiPropertyOptional({ description: 'Fecha de emisión de la factura de la cuota (YYYY-MM-DD); sin valor, mensual desde la original' })
	@ValidateIf((_dto: ReorganizeInstallmentDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'La fecha de emisión de la cuota debe tener la forma YYYY-MM-DD' })
	issue_date?: string | null;
}

/**
 * Una operación de Reorganizar (spec facturas §3.5). Forma plana con `op` como discriminante: cada operación usa sus campos (los demás
 * se ignoran). merge `{ invoice_ids }` · move_line `{ line_id, to_invoice_id | new_invoice }` · split_line `{ line_id, by, at | amount |
 * count | installments, issue_date? }` · split_invoice `{ invoice_id, cut_date, issue_date? }` · item_monthly `{ contract_item_id }` ·
 * item_unify_pending `{ contract_item_id, issue_date? }` · item_even_split `{ contract_item_id, count? }` · round_fix `{ invoice_id }`.
 */
export class ReorganizeOperationDto {
	@ApiProperty({ enum: REORGANIZE_OPS })
	@IsIn(REORGANIZE_OPS, { message: `Operación inválida: ${REORGANIZE_OPS.join(', ')}` })
	op!: ReorganizeOp;

	@ApiPropertyOptional({ type: [String], description: 'merge: facturas Por Emitir a juntar (todas las líneas van a la de emisión más temprana)' })
	@ValidateIf((dto: ReorganizeOperationDto) => dto.op === 'merge')
	@IsArray({ message: 'Indica las facturas a juntar' })
	@ArrayMinSize(2, { message: 'Indica al menos dos facturas para juntar' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	invoice_ids?: string[];

	@ApiPropertyOptional({ description: 'move_line / split_line: línea de una Por Emitir del contrato' })
	@ValidateIf((dto: ReorganizeOperationDto) => LINE_OPS.includes(dto.op))
	@IsUUID(undefined, { message: 'Indica la línea' })
	line_id?: string;

	@ApiPropertyOptional({ description: 'move_line: Por Emitir destino (o new_invoice)' })
	@ValidateIf((dto: ReorganizeOperationDto, value: unknown) => dto.op === 'move_line' && present(value))
	@IsUUID(undefined, { message: 'Factura destino inválida' })
	to_invoice_id?: string | null;

	@ApiPropertyOptional({ type: ReorganizeNewInvoiceDto, description: 'move_line: factura nueva del generador (o to_invoice_id)' })
	@ValidateIf((dto: ReorganizeOperationDto, value: unknown) => dto.op === 'move_line' && present(value))
	@ValidateNested()
	@Type(() => ReorganizeNewInvoiceDto)
	new_invoice?: ReorganizeNewInvoiceDto | null;

	@ApiPropertyOptional({
		enum: SPLIT_LINE_BY,
		description: 'split_line: date (subperíodos, montos por días) · amount (dos partes) · installments (cuotas)',
	})
	@ValidateIf((dto: ReorganizeOperationDto) => dto.op === 'split_line')
	@IsIn(SPLIT_LINE_BY, { message: 'Indica cómo dividir: date, amount o installments' })
	by?: SplitLineBy;

	@ApiPropertyOptional({ description: 'split_line by date: último día de la primera parte (YYYY-MM-DD)' })
	@ValidateIf((dto: ReorganizeOperationDto) => dto.op === 'split_line' && dto.by === 'date')
	@Matches(ISO_DATE, { message: 'La fecha de corte debe tener la forma YYYY-MM-DD' })
	at?: string;

	@ApiPropertyOptional({ description: 'split_line by amount: monto de la primera parte (moneda de contrato)' })
	@ValidateIf((dto: ReorganizeOperationDto) => dto.op === 'split_line' && dto.by === 'amount')
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Indica el monto de la primera parte' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount?: number;

	@ApiPropertyOptional({ description: 'split_line by installments: cuotas parejas · item_even_split: cuotas mensuales nuevas' })
	@ValidateIf((dto: ReorganizeOperationDto, value: unknown) => (dto.op === 'split_line' || dto.op === 'item_even_split') && present(value))
	@IsInt({ message: 'La cantidad de cuotas debe ser un número entero' })
	@Min(1, { message: 'Indica al menos una cuota' })
	@Max(REORGANIZE_MAX_PARTS, { message: `Máximo ${REORGANIZE_MAX_PARTS} cuotas` })
	count?: number | null;

	@ApiPropertyOptional({ type: [ReorganizeInstallmentDto], description: 'split_line by installments: montos distintos por cuota (suman la línea)' })
	@ValidateIf((dto: ReorganizeOperationDto, value: unknown) => dto.op === 'split_line' && present(value))
	@IsArray({ message: 'installments debe ser una lista' })
	@ArrayMinSize(2, { message: 'Indica al menos dos cuotas' })
	@ArrayMaxSize(REORGANIZE_MAX_PARTS, { message: `Máximo ${REORGANIZE_MAX_PARTS} cuotas` })
	@ValidateNested({ each: true })
	@Type(() => ReorganizeInstallmentDto)
	installments?: ReorganizeInstallmentDto[] | null;

	@ApiPropertyOptional({ description: 'split_invoice / round_fix: factura Por Emitir' })
	@ValidateIf((dto: ReorganizeOperationDto) => INVOICE_OPS.includes(dto.op))
	@IsUUID(undefined, { message: 'Indica la factura' })
	invoice_id?: string;

	@ApiPropertyOptional({ description: 'split_invoice: último día que queda en la factura original (YYYY-MM-DD)' })
	@ValidateIf((dto: ReorganizeOperationDto) => dto.op === 'split_invoice')
	@Matches(ISO_DATE, { message: 'La fecha de corte debe tener la forma YYYY-MM-DD' })
	cut_date?: string;

	@ApiPropertyOptional({ description: 'item_monthly / item_unify_pending / item_even_split: ítem del contrato' })
	@ValidateIf((dto: ReorganizeOperationDto) => ITEM_OPS.includes(dto.op))
	@IsUUID(undefined, { message: 'Indica el ítem del contrato' })
	contract_item_id?: string;

	@ApiPropertyOptional({
		description:
			'split_line by date / split_invoice: emisión de la factura nueva (sin valor: la original corrida los mismos meses que el período) · item_unify_pending: emisión de la factura que recibe lo unificado',
	})
	@ValidateIf((dto: ReorganizeOperationDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'La fecha de emisión debe tener la forma YYYY-MM-DD' })
	issue_date?: string | null;
}

/** `POST /contracts/:id/invoices/reorganize/preview` y `POST /contracts/:id/invoices/reorganize` (spec facturas §3.5). */
export class ReorganizeInvoicesDto {
	@ApiProperty({ type: [ReorganizeOperationDto], description: 'Operaciones en orden (se aplican una tras otra sobre el resultado de la anterior)' })
	@IsArray({ message: 'operations debe ser una lista' })
	@ArrayMinSize(1, { message: 'Indica al menos una operación' })
	@ArrayMaxSize(REORGANIZE_OPERATIONS_MAX, { message: `Máximo ${REORGANIZE_OPERATIONS_MAX} operaciones por reorganización` })
	@ValidateNested({ each: true })
	@Type(() => ReorganizeOperationDto)
	operations!: ReorganizeOperationDto[];

	@ApiPropertyOptional({ description: 'Nota de la reorganización (va al evento)', maxLength: REORGANIZE_REASON_MAX })
	@Transform(trim)
	@ValidateIf((_dto: ReorganizeInvoicesDto, value: unknown) => present(value))
	@IsString({ message: 'El motivo debe ser texto' })
	@MaxLength(REORGANIZE_REASON_MAX, { message: `El motivo no puede superar ${REORGANIZE_REASON_MAX} caracteres` })
	reason?: string | null;

	@ApiPropertyOptional({
		type: InvoiceDeviationDto,
		description: 'Motivo tipado (obligatorio al aplicar si cambia el total facturado de algún ítem): fila en invoice_adjustments',
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => InvoiceDeviationDto)
	deviation?: InvoiceDeviationDto | null;
}

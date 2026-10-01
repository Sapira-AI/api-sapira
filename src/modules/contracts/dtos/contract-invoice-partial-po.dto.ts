import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	IsArray,
	IsIn,
	IsNumber,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { VISIBLE_LINE_TEXT_MAX } from '../invoice-partial-po';

import { DEVIATION_REASON_MAX, EDIT_LINES_MAX } from './contract-invoice-edit.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

export class PartialByPoReferenceDto {
	@ApiProperty({ enum: ['OC', 'HES'], description: 'OC (SII 801) u HES' })
	@IsIn(['OC', 'HES'], { message: 'Tipo de referencia inválido: OC o HES' })
	type!: 'OC' | 'HES';

	@ApiProperty({ description: 'Número de la OC/HES' })
	@Transform(trim)
	@IsString({ message: 'Escribe el número de la OC/HES' })
	@Matches(/\S/, { message: 'Escribe el número de la OC/HES' })
	@MaxLength(100, { message: 'El número no puede superar 100 caracteres' })
	code!: string;

	@ApiPropertyOptional({ description: 'Fecha de la OC/HES (YYYY-MM-DD)' })
	@ValidateIf((_dto: PartialByPoReferenceDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'La fecha de la referencia debe tener la forma YYYY-MM-DD' })
	date?: string | null;
}

export class PartialByPoAllocationDto {
	@ApiProperty({ description: 'Línea visible de la factura' })
	@IsUUID(undefined, { message: 'Línea inválida' })
	line_id!: string;

	@ApiProperty({ description: 'Monto cubierto por la OC en MONEDA DE FACTURA (≤ neto de la línea)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto inválido' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount!: number;
}

/** `POST …/:invoiceId/partial-by-po/preview` y `POST …/:invoiceId/partial-by-po` (spec facturas §3.7b). */
export class PartialByPoDto {
	@ApiProperty({ type: PartialByPoReferenceDto })
	@ValidateNested()
	@Type(() => PartialByPoReferenceDto)
	reference!: PartialByPoReferenceDto;

	@ApiProperty({ description: 'Neto de la OC en MONEDA DE FACTURA' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto de la OC inválido' })
	@Min(0.01, { message: 'El monto de la OC debe ser mayor que 0' })
	amount_invoice_currency!: number;

	@ApiPropertyOptional({ type: [PartialByPoAllocationDto], description: 'Asignación manual (reemplaza la propuesta); debe sumar el neto de la OC' })
	@IsOptional()
	@IsArray({ message: 'allocation debe ser una lista' })
	@ArrayMaxSize(EDIT_LINES_MAX, { message: `Máximo ${EDIT_LINES_MAX} líneas` })
	@ValidateNested({ each: true })
	@Type(() => PartialByPoAllocationDto)
	allocation?: PartialByPoAllocationDto[];

	@ApiProperty({ description: 'Texto de la única línea visible del documento (la que viaja al ERP)', maxLength: VISIBLE_LINE_TEXT_MAX })
	@Transform(trim)
	@IsString({ message: 'Escribe el texto de la línea del documento' })
	@Matches(/\S/, { message: 'Escribe el texto de la línea del documento' })
	@MaxLength(VISIBLE_LINE_TEXT_MAX, { message: `El texto no puede superar ${VISIBLE_LINE_TEXT_MAX} caracteres` })
	visible_line_text!: string;

	@ApiProperty({ description: 'Motivo (va al evento)', maxLength: DEVIATION_REASON_MAX })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@Matches(/\S/, { message: 'Escribe el motivo' })
	@MaxLength(DEVIATION_REASON_MAX, { message: `El motivo no puede superar ${DEVIATION_REASON_MAX} caracteres` })
	reason!: string;
}

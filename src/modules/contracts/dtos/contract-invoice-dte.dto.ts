import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

import { DTE_LIMITS } from '../invoice-dte';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined && value !== '';

/** `POST …/:invoiceId/dte-send-receptor`: reenvía el documento al cliente; sin `email`, al correo de intercambio de la razón social. */
export class SendDteToReceptorDto {
	@ApiPropertyOptional({ description: 'Correo al que se envía (sin valor: el de intercambio de la razón social, o su correo)' })
	@ValidateIf((_dto: SendDteToReceptorDto, value: unknown) => present(value))
	@Transform(trim)
	@IsEmail({}, { message: 'Escribe un correo válido' })
	email?: string | null;
}

export const DTE_DOCUMENT_FORMATS = ['pdf', 'xml'] as const;
export const DTE_DOCUMENT_COPIES = ['tributaria', 'cedible'] as const;

/** `GET …/:invoiceId/dte-document?format=pdf|xml&copy=tributaria|cedible`. */
export class DteDocumentQueryDto {
	@ApiPropertyOptional({ enum: DTE_DOCUMENT_FORMATS, default: 'pdf' })
	@IsOptional()
	@IsIn(DTE_DOCUMENT_FORMATS, { message: 'format debe ser pdf o xml' })
	format?: (typeof DTE_DOCUMENT_FORMATS)[number];

	@ApiPropertyOptional({ enum: DTE_DOCUMENT_COPIES, default: 'tributaria', description: 'Solo PDF: ejemplar tributario o cedible' })
	@IsOptional()
	@IsIn(DTE_DOCUMENT_COPIES, { message: 'copy debe ser tributaria o cedible' })
	copy?: (typeof DTE_DOCUMENT_COPIES)[number];
}

/** `POST …/:invoiceId/debit-note[/preview]`: nota de débito sobre una factura emitida (recargo, intereses, diferencia de precio). */
export class CreateDebitNoteDto {
	@ApiProperty({ description: 'Neto que se suma, en la moneda de la factura (pesos en Chile), sin IVA' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'El monto debe ser un número' })
	@Min(1, { message: 'El monto debe ser mayor que 0' })
	amount!: number;

	@ApiProperty({ description: 'Motivo: va en la línea y en la referencia del documento', maxLength: DTE_LIMITS.razon_ref })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo de la nota de débito' })
	@MaxLength(DTE_LIMITS.razon_ref, { message: `El motivo no puede superar ${DTE_LIMITS.razon_ref} caracteres` })
	@Matches(/\S/, { message: 'Escribe el motivo de la nota de débito' })
	reason!: string;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `PATCH /contracts/:id/export-details`: datos de exportación del contrato para la factura de exportación (DTE 110), con los códigos de
 * las tablas de Aduana (`GET /sii/aduana/:tabla` de api-factura). Todos opcionales; `null` en un campo lo quita.
 */
export class ContractExportDetailsDto {
	@ApiPropertyOptional({ enum: ['servicios', 'bienes'], description: 'Servicios (IndServicio 3, sin transporte) o bienes. Sin valor: servicios' })
	@IsIn(['servicios', 'bienes'], { message: 'kind: servicios o bienes' })
	@IsOptional()
	kind?: 'servicios' | 'bienes';

	@ApiPropertyOptional({ description: 'Modalidad de venta (CodModVenta, p. ej. 1 = a firme)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Modalidad de venta inválida' })
	@Min(1)
	@Max(99)
	sale_modality?: number | null;

	@ApiPropertyOptional({ description: 'Cláusula de compraventa (CodClauVenta, p. ej. 5 = FOB)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Cláusula de venta inválida' })
	@Min(1)
	@Max(99)
	sale_clause?: number | null;

	@ApiPropertyOptional({ description: 'Forma de pago de exportación (FmaPagExp, p. ej. 1 = cobranza hasta 1 año)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Forma de pago inválida' })
	@Min(1)
	@Max(99)
	payment_form?: number | null;

	@ApiPropertyOptional({ description: 'Solo bienes: vía de transporte (CodViaTransp, p. ej. 1 = marítima, 4 = aérea)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Vía de transporte inválida' })
	@Min(1)
	@Max(99)
	transport_route?: number | null;

	@ApiPropertyOptional({ description: 'Solo bienes: nombre o identificación del medio de transporte', maxLength: 40 })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@Transform(trim)
	@IsString()
	@MaxLength(40, { message: 'El medio de transporte no puede superar 40 caracteres' })
	carrier_name?: string | null;

	@ApiPropertyOptional({ description: 'Solo bienes: puerto de embarque (código de Aduana)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Puerto de embarque inválido' })
	@Min(1)
	@Max(9999)
	port_of_loading?: number | null;

	@ApiPropertyOptional({ description: 'Solo bienes: puerto de desembarque (código de Aduana)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Puerto de desembarque inválido' })
	@Min(1)
	@Max(9999)
	port_of_unloading?: number | null;

	@ApiPropertyOptional({ description: 'País de destino (código de Aduana). Sin valor: el país del receptor' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'País de destino inválido' })
	@Min(1)
	@Max(999)
	destination_country?: number | null;
}

/**
 * `PATCH /contracts/:id/invoices/:invoiceId/export-details`: datos del embarque de una factura de exportación de bienes, antes de
 * emitirla. Pisan los del contrato. Todos opcionales.
 */
export class InvoiceExportDetailsDto {
	@ApiPropertyOptional({ description: 'Total de bultos' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Total de bultos inválido' })
	@Min(1)
	total_packages?: number | null;

	@ApiPropertyOptional({ description: 'Tipo de bulto (código de Aduana, p. ej. 22 = cajas de cartón)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Tipo de bulto inválido' })
	@Min(1)
	@Max(999)
	package_type?: number | null;

	@ApiPropertyOptional({ description: 'Peso bruto' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Peso bruto inválido' })
	@Min(0)
	gross_weight?: number | null;

	@ApiPropertyOptional({ description: 'Peso neto' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Peso neto inválido' })
	@Min(0)
	net_weight?: number | null;

	@ApiPropertyOptional({ description: 'Unidad de los pesos (código de Aduana, p. ej. 6 = kilogramo neto)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsInt({ message: 'Unidad de peso inválida' })
	@Min(1)
	@Max(99)
	weight_unit?: number | null;

	@ApiPropertyOptional({ description: 'Flete, en la moneda de la factura' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Flete inválido' })
	@Min(0)
	freight?: number | null;

	@ApiPropertyOptional({ description: 'Seguro, en la moneda de la factura' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Seguro inválido' })
	@Min(0)
	insurance?: number | null;

	@ApiPropertyOptional({ description: 'Total de la cláusula de venta (p. ej. valor FOB), en la moneda de la factura' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Total de la cláusula inválido' })
	@Min(0)
	sale_clause_total?: number | null;

	@ApiPropertyOptional({ description: 'Número del DUS (va como referencia 807)', maxLength: 18 })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@Transform(trim)
	@IsString()
	@MaxLength(18, { message: 'El número de DUS no puede superar 18 caracteres' })
	dus_number?: string | null;

	@ApiPropertyOptional({ description: 'Fecha del DUS (AAAA-MM-DD)' })
	@ValidateIf((_dto: unknown, value: unknown) => present(value))
	@Matches(FECHA, { message: 'La fecha del DUS debe tener formato AAAA-MM-DD' })
	dus_date?: string | null;
}

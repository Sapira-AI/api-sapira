import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';

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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import {
	DESCRIPTION_BLOCK_TYPES,
	DESCRIPTION_MODES,
	type DescriptionBlockType,
	type DescriptionMode,
	TEMPLATE_MAX_BLOCKS,
	TEMPLATE_SEPARATOR_MAX,
	TEMPLATE_TEXT_MAX,
} from '../invoice-description';

import { INVOICE_IDS_MAX } from './contract-invoices.dto';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const LINE_IDS_MAX = 1000;
export const DESCRIPTION_TEXT_MAX = 1000;
export const REFERENCE_TYPES = ['OC', 'HES', 'OTHER'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];
export const REFERENCES_MAX = 20;

/** Un bloque de la plantilla (spec facturas §3.6). Formatos y reglas finas (texto obligatorio en `text`) los valida `validateTemplate`. */
export class DescriptionBlockDto {
	@ApiProperty({ enum: DESCRIPTION_BLOCK_TYPES, description: 'Tipo de bloque' })
	@IsIn(DESCRIPTION_BLOCK_TYPES, { message: `Tipo de bloque inválido: ${DESCRIPTION_BLOCK_TYPES.join(', ')}` })
	type!: DescriptionBlockType;

	@ApiPropertyOptional({
		description:
			'account: block | inline · period: range_slash | month_year | mmm_yy | range_dash · tier: label | detail. Los demás bloques no tienen formato',
	})
	@IsString({ message: 'Formato inválido' })
	@IsOptional()
	format?: string;

	@ApiPropertyOptional({
		description: 'Texto libre (bloque text, obligatorio) o etiqueta del bloque de datos ("Periodo", "OC")',
		maxLength: TEMPLATE_TEXT_MAX,
	})
	@IsString({ message: 'El texto debe ser texto' })
	@MaxLength(TEMPLATE_TEXT_MAX, { message: `El texto no puede superar ${TEMPLATE_TEXT_MAX} caracteres` })
	@IsOptional()
	text?: string;
}

/** Plantilla de descripción `{ separator?, blocks[] }`. */
export class DescriptionTemplateDto {
	@ApiPropertyOptional({ description: 'Separador entre bloques (default " - ")', maxLength: TEMPLATE_SEPARATOR_MAX })
	@IsString({ message: 'El separador debe ser texto' })
	@MaxLength(TEMPLATE_SEPARATOR_MAX, { message: `El separador no puede superar ${TEMPLATE_SEPARATOR_MAX} caracteres` })
	@IsOptional()
	separator?: string;

	@ApiProperty({ type: [DescriptionBlockDto], description: `Bloques en orden (1 a ${TEMPLATE_MAX_BLOCKS})` })
	@IsArray({ message: 'La plantilla necesita bloques' })
	@ArrayMinSize(1, { message: 'La plantilla necesita al menos un bloque' })
	@ArrayMaxSize(TEMPLATE_MAX_BLOCKS, { message: `La plantilla admite hasta ${TEMPLATE_MAX_BLOCKS} bloques` })
	@ValidateNested({ each: true })
	@Type(() => DescriptionBlockDto)
	blocks!: DescriptionBlockDto[];
}

/** `POST /contracts/:id/invoice-description-template/preview`: renderiza sin guardar. */
export class PreviewDescriptionTemplateDto {
	@ApiProperty({ type: DescriptionTemplateDto, description: 'Plantilla a probar' })
	@IsObject({ message: 'Indica la plantilla' })
	@ValidateNested()
	@Type(() => DescriptionTemplateDto)
	template!: DescriptionTemplateDto;

	@ApiPropertyOptional({ description: 'Línea de muestra (de una Por Emitir del contrato); default: la primera de la próxima Por Emitir' })
	@IsUUID(undefined, { message: 'Línea inválida' })
	@IsOptional()
	line_id?: string;
}

/** `PUT /contracts/:id/invoice-description-template`: guarda (o quita con `null`) la plantilla del contrato. */
export class SaveDescriptionTemplateDto {
	@ApiProperty({ type: DescriptionTemplateDto, nullable: true, description: 'Plantilla del contrato; null = volver a la glosa estándar' })
	@ValidateIf((dto: SaveDescriptionTemplateDto) => dto.template !== null)
	@IsObject({ message: 'Indica la plantilla (o null para volver a la estándar)' })
	@ValidateNested()
	@Type(() => DescriptionTemplateDto)
	template!: DescriptionTemplateDto | null;

	@ApiPropertyOptional({ default: false, description: 'Regenera las líneas de las Por Emitir activas no protegidas ni enviadas al ERP' })
	@IsBoolean({ message: 'apply_to_pending debe ser verdadero o falso' })
	@IsOptional()
	apply_to_pending?: boolean;
}

/** `POST /contracts/:id/invoices/descriptions/preview` y `PATCH /contracts/:id/invoices/descriptions`. */
export class UpdateInvoiceDescriptionsDto {
	@ApiPropertyOptional({ type: [String], description: 'Facturas Por Emitir del contrato (todas sus líneas)' })
	@IsArray({ message: 'Indica las facturas' })
	@ArrayMaxSize(INVOICE_IDS_MAX, { message: `Máximo ${INVOICE_IDS_MAX} facturas por operación` })
	@IsUUID(undefined, { each: true, message: 'Factura inválida' })
	@IsOptional()
	invoice_ids?: string[];

	@ApiPropertyOptional({ type: [String], description: 'Líneas puntuales (de Por Emitir del contrato)' })
	@IsArray({ message: 'Indica las líneas' })
	@ArrayMaxSize(LINE_IDS_MAX, { message: `Máximo ${LINE_IDS_MAX} líneas por operación` })
	@IsUUID(undefined, { each: true, message: 'Línea inválida' })
	@IsOptional()
	line_ids?: string[];

	@ApiProperty({
		enum: DESCRIPTION_MODES,
		description:
			'apply_template: plantilla del contrato · apply_blocks: la plantilla del body, solo esta vez · set: texto manual (protege la línea) · unlock: libera y regenera con la plantilla del contrato',
	})
	@IsIn(DESCRIPTION_MODES, { message: 'Modo inválido: apply_template, apply_blocks, set o unlock' })
	mode!: DescriptionMode;

	@ApiPropertyOptional({ type: DescriptionTemplateDto, description: 'Obligatoria con apply_blocks' })
	@ValidateIf((dto: UpdateInvoiceDescriptionsDto) => dto.mode === 'apply_blocks' || (dto.template !== undefined && dto.template !== null))
	@IsObject({ message: 'Indica la plantilla a aplicar' })
	@ValidateNested()
	@Type(() => DescriptionTemplateDto)
	template?: DescriptionTemplateDto;

	@ApiPropertyOptional({ description: 'Obligatorio con set', maxLength: DESCRIPTION_TEXT_MAX })
	@ValidateIf((dto: UpdateInvoiceDescriptionsDto) => dto.mode === 'set' || (dto.text !== undefined && dto.text !== null))
	@Transform(trim)
	@IsString({ message: 'Escribe la descripción' })
	@MaxLength(DESCRIPTION_TEXT_MAX, { message: `La descripción no puede superar ${DESCRIPTION_TEXT_MAX} caracteres` })
	@Matches(/\S/, { message: 'Escribe la descripción' })
	text?: string;

	@ApiPropertyOptional({ default: false, description: 'apply_template / apply_blocks: incluir líneas protegidas (escritas a mano)' })
	@IsBoolean({ message: 'include_locked debe ser verdadero o falso' })
	@IsOptional()
	include_locked?: boolean;
}

/** Una referencia OC/HES de la factura (spec facturas §3.7a). */
export class InvoiceReferenceDto {
	@ApiProperty({ enum: REFERENCE_TYPES, description: 'OC (SII 801) · HES · OTHER (con document_type_code)' })
	@IsIn(REFERENCE_TYPES, { message: 'Tipo de referencia inválido: OC, HES u OTHER' })
	type!: ReferenceType;

	@ApiProperty({ description: 'Número o folio del documento referenciado' })
	@Transform(trim)
	@IsString({ message: 'Escribe el número de la referencia' })
	@MaxLength(100, { message: 'El número no puede superar 100 caracteres' })
	@Matches(/\S/, { message: 'Escribe el número de la referencia' })
	code!: string;

	@ApiPropertyOptional({ description: 'Fecha del documento referenciado (YYYY-MM-DD)' })
	@ValidateIf((_dto: InvoiceReferenceDto, value: unknown) => value !== null && value !== undefined)
	@Matches(ISO_DATE, { message: 'La fecha debe tener la forma YYYY-MM-DD' })
	date?: string | null;

	@ApiPropertyOptional({ description: 'Nombre del documento (default: Orden de Compra / Hoja de Entrada de Servicio)' })
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ description: 'Solo OTHER: código SII del documento referenciado (802, 803, 804, 805, 33…)' })
	@ValidateIf((dto: InvoiceReferenceDto) => dto.type === 'OTHER')
	@Transform(trim)
	@IsString({ message: 'Indica el código del documento referenciado' })
	@MaxLength(20, { message: 'El código no puede superar 20 caracteres' })
	@Matches(/\S/, { message: 'Indica el código del documento referenciado' })
	document_type_code?: string;
}

/** `PUT /contracts/:id/invoices/:invoiceId/references`: juego completo de las referencias propias de la factura. */
export class UpdateInvoiceReferencesDto {
	@ApiProperty({ type: [InvoiceReferenceDto], description: 'Reemplaza las referencias propias de la factura ([] = sin referencias)' })
	@IsArray({ message: 'Indica las referencias' })
	@ArrayMaxSize(REFERENCES_MAX, { message: `Máximo ${REFERENCES_MAX} referencias por factura` })
	@ValidateNested({ each: true })
	@Type(() => InvoiceReferenceDto)
	references!: InvoiceReferenceDto[];

	@ApiPropertyOptional({ description: 'Si viene, actualiza invoices.requires_references_for_billing' })
	@IsBoolean({ message: 'requires_references_for_billing debe ser verdadero o falso' })
	@IsOptional()
	requires_references_for_billing?: boolean;
}

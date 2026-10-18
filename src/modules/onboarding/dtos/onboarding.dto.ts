import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
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
	MinLength,
	ValidateBy,
	ValidateNested,
} from 'class-validator';

import { BILLING_FREQUENCIES, BILLING_METHODS, type BillingFrequency, type BillingMethod } from '@/modules/contracts/billing-engine';
import { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';

/**
 * Entradas del módulo `onboarding` (contrato: `docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` §5; formas de respuesta:
 * `docs/v2-rediseno/mapa-v2-onboarding.md`). Nombres de campo exactos del contrato.
 */

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Un solo estado pendiente (Domi 14-10): "terminó sin resolver" es el filtro `ended=true` sobre `pending`, no otro estado. */
export const HISTORY_LINE_STATUSES = ['pending', 'linked', 'closed', 'removed'] as const;
export type HistoryLineStatus = (typeof HISTORY_LINE_STATUSES)[number];
export const HISTORY_SORT_FIELDS = ['client', 'product', 'last_month', 'mrr', 'status'] as const;
export const PREVIOUS_INVOICE_STATUSES = ['Pagada', 'Enviada', 'Vencida'] as const;
export const PREVIOUS_INVOICE_SORT_FIELDS = ['issue_date', 'due_date', 'invoice_number', 'client', 'total', 'status'] as const;
export const PREVIOUS_INVOICE_SOURCE_TYPES = ['historical_import', 'erp_unmatched', 'manual_entry'] as const;
export const REMOVE_REASONS = ['duplicate', 'error'] as const;
export const IMPORT_MAX_INVOICES = 2000;

/** Lista separada por comas en que cada valor pertenece a `allowed`. */
const CsvIn = (allowed: readonly string[], message: string) =>
	ValidateBy({
		name: 'csvIn',
		validator: {
			validate: (value: unknown) =>
				typeof value === 'string' &&
				value
					.split(',')
					.map((part) => part.trim())
					.filter(Boolean)
					.every((part) => allowed.includes(part)),
			defaultMessage: () => message,
		},
	});

class PageQueryDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt({ message: 'Página inválida' })
	@Min(1, { message: 'Página inválida' })
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25, maximum: 200 })
	@Type(() => Number)
	@IsInt({ message: 'Tamaño de página inválido' })
	@Min(1, { message: 'Tamaño de página inválido' })
	@Max(200, { message: 'Máximo 200 por página' })
	@IsOptional()
	limit?: number;
}

// ── MRR histórico ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class HistoryLinesQueryDto extends PageQueryDto {
	@ApiPropertyOptional({ description: `Uno o varios, separados por coma: ${HISTORY_LINE_STATUSES.join(', ')}` })
	@CsvIn(HISTORY_LINE_STATUSES, `Estado inválido: usa ${HISTORY_LINE_STATUSES.join(', ')}`)
	@IsOptional()
	status?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Nombre exacto del producto' })
	@Transform(trim)
	@IsString()
	@MaxLength(200)
	@IsOptional()
	product?: string;

	@ApiPropertyOptional({
		enum: ['true', 'false'],
		description: 'Solo líneas pendientes: `true` = su último mes ya pasó (terminó sin resolver); `false` = pendientes vigentes',
	})
	@IsIn(['true', 'false'], { message: 'ended debe ser true o false' })
	@IsOptional()
	ended?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Lote de MRR histórico (`mrr_legacy.batch_id`)' })
	@IsUUID(undefined, { message: 'Lote inválido' })
	@IsOptional()
	batchId?: string;

	@ApiPropertyOptional({ description: 'Cliente, razón social o producto' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({
		enum: HISTORY_SORT_FIELDS,
		description: 'Sin orden: prioridad de estado (pendiente → empalmada → cerrada → quitada) y cliente',
	})
	@IsIn(HISTORY_SORT_FIELDS, { message: 'Orden inválido' })
	@IsOptional()
	sortBy?: (typeof HISTORY_SORT_FIELDS)[number];

	@ApiPropertyOptional({ enum: ['asc', 'desc'] })
	@IsIn(['asc', 'desc'], { message: 'Dirección de orden inválida' })
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

/** Moneda de la serie del MRR histórico (Domi 18-10): sistema, moneda de contrato o moneda de factura. */
export const HISTORY_SERIES_CURRENCIES = ['system', 'contract', 'invoice'] as const;
export type HistorySeriesCurrency = (typeof HISTORY_SERIES_CURRENCIES)[number];

/** Filtros comunes de la serie del MRR histórico (`GET /onboarding/history/series`). */
export class HistorySeriesQueryDto {
	@ApiPropertyOptional({
		enum: HISTORY_SERIES_CURRENCIES,
		default: 'system',
		description:
			'`system`: montos en moneda de sistema; `contract` / `invoice`: un desglose por moneda de contrato o de factura (`contracts` sigue en moneda de sistema)',
	})
	@IsIn(HISTORY_SERIES_CURRENCIES, { message: `Moneda inválida: usa ${HISTORY_SERIES_CURRENCIES.join(', ')}` })
	@IsOptional()
	currency?: HistorySeriesCurrency;

	@ApiPropertyOptional({ description: 'Compañía emisora (`mrr_legacy.company_id`)' })
	@IsUUID(undefined, { message: 'Compañía inválida' })
	@IsOptional()
	companyId?: string;

	@ApiPropertyOptional({ description: 'Cliente comercial' })
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Razón social receptora (la de la factura de origen)' })
	@IsUUID(undefined, { message: 'Razón social inválida' })
	@IsOptional()
	entityId?: string;

	@ApiPropertyOptional({ example: 'BR', description: 'País de la razón social receptora (código ISO de 2 letras)' })
	@Transform(upper)
	@Matches(/^[A-Z]{2}$/, { message: 'País inválido (código de 2 letras)' })
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({
		example: '2025-01',
		description: 'Por defecto, el mayor entre el inicio de la historia del holding y el primer mes con datos',
	})
	@Matches(MONTH, { message: 'Mes desde inválido (AAAA-MM)' })
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ example: '2026-09', description: 'Por defecto, el último mes con datos' })
	@Matches(MONTH, { message: 'Mes hasta inválido (AAAA-MM)' })
	@IsOptional()
	to?: string;
}

export class LinkHistoryLineDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Elige un contrato' })
	contract_id!: string;
}

export class CloseHistoryLineDto {
	@ApiPropertyOptional({ description: 'Comentario (queda como texto del motivo)' })
	@Transform(trim)
	@IsString()
	@MaxLength(500, { message: 'Comentario: máximo 500 caracteres' })
	@IsOptional()
	reason?: string;
}

export class RemoveHistoryLineDto {
	@ApiProperty({ enum: REMOVE_REASONS })
	@IsIn(REMOVE_REASONS, { message: 'Indica si es un duplicado o un error de carga' })
	reason!: (typeof REMOVE_REASONS)[number];

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(500, { message: 'Nota: máximo 500 caracteres' })
	@IsOptional()
	notes?: string;
}

export class HistoryOriginDto {
	@ApiProperty({ enum: ['history'] })
	@IsIn(['history'], { message: 'Origen inválido' })
	type!: 'history';

	@ApiProperty({ description: 'Clave de la línea (la misma de la URL)' })
	@IsString()
	@MaxLength(600)
	line_key!: string;
}

/**
 * Alta desde el MRR histórico: el `CreateContractDto` de Contratos + `origin`. El generador común no guarda `origin` (no tiene columna):
 * el origen queda en el empalme (`mrr_legacy.migrated_to_contract_id`) y en el evento `history_contract_created`.
 */
export class OnboardingContractDto extends CreateContractDto {
	@ApiPropertyOptional({ type: HistoryOriginDto })
	@ValidateNested()
	@Type(() => HistoryOriginDto)
	@IsOptional()
	origin?: HistoryOriginDto;
}

// ── Facturas previas ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export class PreviousInvoicesQueryDto extends PageQueryDto {
	@ApiPropertyOptional({ description: `Uno o varios: ${PREVIOUS_INVOICE_STATUSES.join(', ')}` })
	@CsvIn(PREVIOUS_INVOICE_STATUSES, `Estado inválido: usa ${PREVIOUS_INVOICE_STATUSES.join(', ')}`)
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({ enum: ['true', 'false'], description: 'Con o sin contrato vinculado' })
	@IsIn(['true', 'false'], { message: 'linked debe ser true o false' })
	@IsOptional()
	linked?: 'true' | 'false';

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Razón social inválida' })
	@IsOptional()
	entityId?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Lote inválido' })
	@IsOptional()
	batchId?: string;

	@ApiPropertyOptional({ enum: ['true', 'false'], description: 'Con o sin MRR histórico registrado' })
	@IsIn(['true', 'false'], { message: 'hasHistory debe ser true o false' })
	@IsOptional()
	hasHistory?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Compañía emisora' })
	@IsUUID(undefined, { message: 'Compañía inválida' })
	@IsOptional()
	companyId?: string;

	@ApiPropertyOptional({ example: 'BR', description: 'País de la razón social (código ISO de 2 letras)' })
	@Transform(upper)
	@Matches(/^[A-Z]{2}$/, { message: 'País inválido (código de 2 letras)' })
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({ description: 'Número de factura o razón social' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ example: '2025-01-01' })
	@Matches(DATE, { message: 'Fecha desde inválida (AAAA-MM-DD)' })
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ example: '2026-12-31' })
	@Matches(DATE, { message: 'Fecha hasta inválida (AAAA-MM-DD)' })
	@IsOptional()
	to?: string;

	@ApiPropertyOptional({ enum: PREVIOUS_INVOICE_SORT_FIELDS, default: 'issue_date' })
	@IsIn(PREVIOUS_INVOICE_SORT_FIELDS, { message: 'Orden inválido' })
	@IsOptional()
	sortBy?: (typeof PREVIOUS_INVOICE_SORT_FIELDS)[number];

	@ApiPropertyOptional({ enum: ['asc', 'desc'] })
	@IsIn(['asc', 'desc'], { message: 'Dirección de orden inválida' })
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

export class PreviousInvoiceItemInputDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(500)
	@IsOptional()
	description?: string;

	@ApiPropertyOptional({ description: 'Código del producto (se compara con el código del catálogo)' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	product_external_code?: string;

	@ApiPropertyOptional({ default: 1 })
	@IsNumber({ maxDecimalPlaces: 4 }, { message: 'Cantidad inválida' })
	@IsOptional()
	quantity?: number;

	@ApiPropertyOptional()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Unitario inválido' })
	@IsOptional()
	unit_price?: number;

	@ApiPropertyOptional()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Descuento inválido' })
	@Min(0)
	@Max(100)
	@IsOptional()
	discount_pct?: number;

	@ApiProperty()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el subtotal de la línea' })
	subtotal!: number;

	@ApiPropertyOptional()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Impuesto inválido' })
	@IsOptional()
	tax_amount?: number;

	@ApiPropertyOptional()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Total de línea inválido' })
	@IsOptional()
	total?: number;

	// ── Histórico en el mismo paso (Domi 14-10): si todas las líneas traen esto completo, la importación registra el MRR histórico.

	@ApiPropertyOptional({ description: 'Producto del catálogo: nombre o código' })
	@Transform(trim)
	@IsString()
	@MaxLength(200)
	@IsOptional()
	product?: string;

	@ApiPropertyOptional({ example: '2026-07', description: 'Primer mes que cubre la línea' })
	@Matches(MONTH, { message: 'Período desde inválido (AAAA-MM)' })
	@IsOptional()
	period_from?: string;

	@ApiPropertyOptional({ example: '2026-07', description: 'Último mes que cubre la línea' })
	@Matches(MONTH, { message: 'Período hasta inválido (AAAA-MM)' })
	@IsOptional()
	period_to?: string;

	@ApiPropertyOptional({ example: 'USD' })
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'Moneda de contrato inválida' })
	@IsOptional()
	contract_currency?: string;

	@ApiPropertyOptional({ description: 'Monto de la línea en moneda de contrato, por todo el período' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto en moneda de contrato inválido' })
	@IsOptional()
	amount_contract_currency?: number;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'Indica si la línea es recurrente' })
	@IsOptional()
	is_recurring?: boolean;
}

export class PreviousInvoiceInputDto {
	@ApiProperty({ description: 'Fila de la planilla (para los errores)' })
	@Type(() => Number)
	@IsInt({ message: 'Fila inválida' })
	@Min(1)
	row!: number;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'Escribe el número de factura' })
	@MinLength(1, { message: 'Escribe el número de factura' })
	@MaxLength(80)
	invoice_number!: string;

	@ApiProperty({ example: '2026-07-01' })
	@Matches(DATE, { message: 'Fecha de emisión inválida (AAAA-MM-DD)' })
	issue_date!: string;

	@ApiPropertyOptional()
	@Matches(DATE, { message: 'Fecha de vencimiento inválida (AAAA-MM-DD)' })
	@IsOptional()
	due_date?: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'Escribe la razón social' })
	@MinLength(1, { message: 'Escribe la razón social' })
	@MaxLength(300)
	legal_client_name!: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(40)
	@IsOptional()
	client_tax_id?: string;

	@ApiPropertyOptional({ description: 'Id de la cuenta del cliente comercial en el CRM (relaciona la factura con su cliente)' })
	@Transform(trim)
	@IsString()
	@MaxLength(80)
	@IsOptional()
	client_crm_id?: string;

	@ApiPropertyOptional({ description: 'Número de cliente (relaciona la factura con su cliente comercial)' })
	@Transform(trim)
	@IsString()
	@MaxLength(80)
	@IsOptional()
	client_number?: string;

	@ApiPropertyOptional({ example: 'BR', description: 'País de la razón social (código ISO de 2 letras); se propone al crearla' })
	@Transform(upper)
	@Matches(/^[A-Z]{2}$/, { message: 'País inválido (código de 2 letras)' })
	@IsOptional()
	country?: string;

	@ApiProperty({ description: 'Razón social de la compañía emisora' })
	@Transform(trim)
	@IsString({ message: 'Escribe la compañía emisora' })
	@MinLength(1, { message: 'Escribe la compañía emisora' })
	@MaxLength(300)
	company_name!: string;

	@ApiPropertyOptional({ enum: PREVIOUS_INVOICE_SOURCE_TYPES, default: 'historical_import' })
	@IsIn(PREVIOUS_INVOICE_SOURCE_TYPES, { message: 'Origen inválido' })
	@IsOptional()
	source_type?: (typeof PREVIOUS_INVOICE_SOURCE_TYPES)[number];

	@ApiPropertyOptional({ description: 'Sistema de origen (texto libre: planilla, ERP anterior…)' })
	@Transform(trim)
	@IsString()
	@MaxLength(80)
	@IsOptional()
	source_system?: string;

	@ApiPropertyOptional({ description: 'Id de la factura en el ERP (deduplica igual que el número)' })
	@Type(() => Number)
	@IsInt({ message: 'Id del ERP inválido' })
	@IsOptional()
	erp_invoice_id?: number;

	@ApiProperty({ example: 'BRL' })
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'Moneda inválida' })
	currency!: string;

	@ApiProperty({ description: 'Neto' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el neto' })
	amount!: number;

	@ApiPropertyOptional()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Impuesto inválido' })
	@IsOptional()
	vat?: number;

	@ApiProperty()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el total' })
	total!: number;

	@ApiPropertyOptional({ enum: PREVIOUS_INVOICE_STATUSES, default: 'Enviada' })
	@IsIn(PREVIOUS_INVOICE_STATUSES, { message: 'Estado de cobro inválido: Pagada, Enviada o Vencida' })
	@IsOptional()
	status?: (typeof PREVIOUS_INVOICE_STATUSES)[number];

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(2000)
	@IsOptional()
	notes?: string;

	@ApiProperty({ type: [PreviousInvoiceItemInputDto] })
	@ValidateNested({ each: true })
	@Type(() => PreviousInvoiceItemInputDto)
	@ArrayMaxSize(200, { message: 'Máximo 200 líneas por factura' })
	@IsArray({ message: 'Indica las líneas de la factura' })
	items!: PreviousInvoiceItemInputDto[];
}

export class ImportPreviewDto {
	@ApiProperty({ type: [PreviousInvoiceInputDto], description: `Máximo ${IMPORT_MAX_INVOICES}` })
	@ValidateNested({ each: true })
	@Type(() => PreviousInvoiceInputDto)
	@ArrayMinSize(1, { message: 'La planilla no tiene facturas' })
	@ArrayMaxSize(IMPORT_MAX_INVOICES, { message: `Máximo ${IMPORT_MAX_INVOICES} facturas por importación` })
	@IsArray({ message: 'Indica las facturas' })
	invoices!: PreviousInvoiceInputDto[];

	@ApiPropertyOptional({ description: 'Nombre del lote' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	batch_label?: string;
}

export class CreateEntityInputDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'Escribe la razón social' })
	@MinLength(1, { message: 'Escribe la razón social' })
	@MaxLength(300)
	legal_name!: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(40)
	@IsOptional()
	tax_id?: string;

	@ApiProperty({ description: 'País (código ISO de 2 letras, como el selector de país)' })
	@Transform(trim)
	@IsString({ message: 'Elige el país' })
	@MinLength(2, { message: 'Elige el país' })
	@MaxLength(60)
	country!: string;

	@ApiPropertyOptional({ description: 'Cliente comercial existente (viene del CRM). La importación nunca crea clientes comerciales' })
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	client_id?: string;
}

export class ImportApplyDto extends ImportPreviewDto {
	@ApiPropertyOptional({ type: [CreateEntityInputDto], description: 'Razones sociales faltantes confirmadas en bloque (nunca se crean solas)' })
	@ValidateNested({ each: true })
	@Type(() => CreateEntityInputDto)
	@ArrayMaxSize(1000)
	@IsArray()
	@IsOptional()
	create_entities?: CreateEntityInputDto[];
}

export class AssignInvoiceClientDto {
	@ApiProperty({ description: 'Cliente comercial existente' })
	@IsUUID(undefined, { message: 'Elige un cliente comercial' })
	client_id!: string;
}

export class HistoryProductAmountDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Elige un producto' })
	product_id!: string;

	@ApiProperty({ description: 'Parte del monto (moneda de contrato) que corresponde a este producto, por todo el período' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el monto del producto' })
	amount_contract_currency!: number;
}

/** Lo que completa la usuaria por factura (§3.2b): período que cubre, monto en moneda de contrato y productos. */
export class RegisterHistoryInvoiceDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Factura inválida' })
	invoice_id!: string;

	@ApiProperty({ example: '2026-07' })
	@Matches(MONTH, { message: 'Período desde inválido (AAAA-MM)' })
	period_from!: string;

	@ApiProperty({ example: '2026-07' })
	@Matches(MONTH, { message: 'Período hasta inválido (AAAA-MM)' })
	period_to!: string;

	@ApiProperty({ example: 'USD' })
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'Moneda de contrato inválida' })
	contract_currency!: string;

	@ApiProperty({ description: 'Monto de la factura en moneda de contrato (por todo el período)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el monto en moneda de contrato' })
	amount_contract_currency!: number;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'Indica si es recurrente' })
	@IsOptional()
	is_recurring?: boolean;

	@ApiProperty({ type: [HistoryProductAmountDto] })
	@ValidateNested({ each: true })
	@Type(() => HistoryProductAmountDto)
	@ArrayMinSize(1, { message: 'Elige al menos un producto' })
	@ArrayMaxSize(50)
	@IsArray({ message: 'Elige los productos' })
	products!: HistoryProductAmountDto[];
}

/**
 * Editar una línea = volver a registrar sus facturas (Domi 14-10): una entrada por factura de la línea, con lo mismo que Registrar histórico
 * (§3.2b). Las facturas no listadas no cambian. Si cambia el producto o la moneda, las filas nuevas caen en otra línea.
 */
export class EditHistoryLineDto {
	@ApiProperty({ type: [RegisterHistoryInvoiceDto] })
	@ValidateNested({ each: true })
	@Type(() => RegisterHistoryInvoiceDto)
	@ArrayMinSize(1, { message: 'Indica al menos una factura de la línea' })
	@ArrayMaxSize(500, { message: 'Máximo 500 facturas por cambio' })
	@IsArray({ message: 'Indica las facturas' })
	invoices!: RegisterHistoryInvoiceDto[];
}

export class RegisterHistoryDto {
	@ApiProperty({ type: [RegisterHistoryInvoiceDto] })
	@ValidateNested({ each: true })
	@Type(() => RegisterHistoryInvoiceDto)
	@ArrayMinSize(1, { message: 'Elige al menos una factura' })
	@ArrayMaxSize(2000, { message: 'Máximo 2.000 facturas por registro' })
	@IsArray()
	invoices!: RegisterHistoryInvoiceDto[];
}

// ── Arranque rápido ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export class QuickStartPreviewDto {
	@ApiProperty({ example: '2026-07', description: 'Mes de corte: última factura hasta este mes' })
	@Matches(MONTH, { message: 'Mes de corte inválido (AAAA-MM)' })
	as_of!: string;

	@ApiPropertyOptional({ type: [String], description: 'Razones sociales (sin filtro: todas las que tienen facturas previas)' })
	@IsUUID(undefined, { each: true, message: 'Razón social inválida' })
	@ArrayMaxSize(2000)
	@IsArray()
	@IsOptional()
	entity_ids?: string[];

	@ApiPropertyOptional({ minimum: 0, maximum: 24, default: 0, description: 'Meses anteriores con factura que también entran como MRR histórico' })
	@Type(() => Number)
	@IsInt({ message: 'Meses de historia: 0 a 24' })
	@Min(0, { message: 'Meses de historia: 0 a 24' })
	@Max(24, { message: 'Meses de historia: 0 a 24' })
	@IsOptional()
	history_months?: number;

	@ApiPropertyOptional({
		type: () => [QuickStartProposalDto],
		description:
			'Opcional: lo que la usuaria ya completó por cliente (mismo cuerpo que al aplicar). Con él, la propuesta trae el tipo de cambio implícito, avisos y errores del registro',
	})
	@ValidateNested({ each: true })
	@Type(() => QuickStartProposalDto)
	@ArrayMaxSize(2000)
	@IsArray()
	@IsOptional()
	proposals?: QuickStartProposalDto[];
}

export class QuickStartProductDto extends HistoryProductAmountDto {
	@ApiPropertyOptional({ description: 'Cantidad del ítem del contrato (default 1)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Cantidad inválida' })
	@Min(0.000001, { message: 'La cantidad debe ser mayor que 0' })
	@IsOptional()
	quantity?: number;

	@ApiPropertyOptional({ description: 'Unitario del ítem (default: monto mensual ÷ cantidad)' })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Unitario inválido' })
	@Min(0, { message: 'El unitario no puede ser negativo' })
	@IsOptional()
	unit_price?: number;
}

/** Por cliente: lo de §3.2b sobre su última factura + frecuencia y método del contrato. */
export class QuickStartProposalDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Razón social inválida' })
	entity_id!: string;

	@ApiProperty({ example: '2026-07' })
	@Matches(MONTH, { message: 'Período desde inválido (AAAA-MM)' })
	period_from!: string;

	@ApiProperty({ example: '2026-07' })
	@Matches(MONTH, { message: 'Período hasta inválido (AAAA-MM)' })
	period_to!: string;

	@ApiProperty({ example: 'USD' })
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'Moneda de contrato inválida' })
	contract_currency!: string;

	@ApiProperty()
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Escribe el monto en moneda de contrato' })
	amount_contract_currency!: number;

	@ApiProperty({ type: [QuickStartProductDto] })
	@ValidateNested({ each: true })
	@Type(() => QuickStartProductDto)
	@ArrayMaxSize(50)
	@IsArray({ message: 'Elige los productos' })
	products!: QuickStartProductDto[];

	@ApiPropertyOptional({ enum: BILLING_FREQUENCIES, default: 'Mensual' })
	@IsIn(BILLING_FREQUENCIES, { message: 'Frecuencia inválida' })
	@IsOptional()
	billing_frequency?: BillingFrequency;

	@ApiPropertyOptional({ enum: BILLING_METHODS, default: 'Anticipado' })
	@IsIn(BILLING_METHODS, { message: 'Método inválido' })
	@IsOptional()
	billing_method?: BillingMethod;

	@ApiPropertyOptional({ default: 12 })
	@Type(() => Number)
	@IsInt({ message: 'El plazo va en meses enteros' })
	@Min(1)
	@Max(600)
	@IsOptional()
	term_months?: number;
}

export class QuickStartApplyDto {
	@ApiProperty({ example: '2026-07' })
	@Matches(MONTH, { message: 'Mes de corte inválido (AAAA-MM)' })
	as_of!: string;

	@ApiProperty({ type: [QuickStartProposalDto] })
	@ValidateNested({ each: true })
	@Type(() => QuickStartProposalDto)
	@ArrayMinSize(1, { message: 'Elige al menos un cliente' })
	@ArrayMaxSize(500, { message: 'Máximo 500 clientes por arranque' })
	@IsArray()
	proposals!: QuickStartProposalDto[];
}

// ── Eventos ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class OnboardingEventsQueryDto extends PageQueryDto {
	@ApiPropertyOptional({ description: 'Clave de línea (la de la URL)' })
	@IsString()
	@MaxLength(600)
	@IsOptional()
	lineKey?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Registro inválido' })
	@IsOptional()
	entityId?: string;
}

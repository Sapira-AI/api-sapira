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
	IsPositive,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';

import { MATCH_CONFIDENCES, MOVEMENT_STATES } from '../billing-reconciliation-match';
import {
	DATE_FORMATS,
	type DateFormat,
	DECIMAL_SEPARATORS,
	SIGN_CONVENTIONS,
	STATEMENT_FORMATS,
	STATEMENT_MAX_ROWS,
	THOUSANDS_SEPARATORS,
} from '../billing-reconciliation-statement';
import { SETTLEMENT_REASONS, type SettlementReason } from '../billing-states';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (values: readonly string[]) => new RegExp(`^(${values.map(escape).join('|')})(,(${values.map(escape).join('|')})){0,9}$`);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export const RECONCILIATION_KPIS = ['pending', 'reconciled', 'differences', 'unidentified'] as const;
export type ReconciliationKpi = (typeof RECONCILIATION_KPIS)[number];
export const CONFIDENCE_FILTERS = [...MATCH_CONFIDENCES, 'none'] as const;
export const IGNORE_REASONS_HINT = 'préstamo, aporte, traspaso entre cuentas, devolución u otro';

/** Umbral (% del saldo) para sugerir comisión bancaria; default 1. */
class FeeThresholdDto {
	@ApiPropertyOptional({ default: 1, minimum: 0, maximum: 10, description: 'Umbral en % del saldo para sugerir comisión bancaria' })
	@Type(() => Number)
	@IsNumber({}, { message: 'fee_threshold_pct debe ser un número' })
	@Min(0)
	@Max(10, { message: 'fee_threshold_pct máximo 10' })
	@IsOptional()
	fee_threshold_pct?: number;
}

export class ReconciliationSuggestionsQueryDto extends FeeThresholdDto {}

export class ReconciliationSummaryQueryDto {
	@ApiPropertyOptional({ description: 'Desde YYYY-MM-DD (fecha del movimiento; Conciliado del período: fecha de conciliación)' })
	@Matches(ISO_DATE, { message: 'from debe ser YYYY-MM-DD' })
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ description: 'Hasta YYYY-MM-DD (incluido)' })
	@Matches(ISO_DATE, { message: 'to debe ser YYYY-MM-DD' })
	@IsOptional()
	to?: string;

	@ApiPropertyOptional({ description: 'Cuenta bancaria (company_bank_accounts.id)' })
	@IsUUID(undefined, { message: 'bank_account_id debe ser un UUID' })
	@IsOptional()
	bank_account_id?: string;
}

export class ReconciliationMovementsQueryDto extends ReconciliationSummaryQueryDto {
	@ApiPropertyOptional({ description: `Estado (${MOVEMENT_STATES.join(', ')}); varios separados por coma. Sin estado ni kpi: pending,partial` })
	@Matches(list(MOVEMENT_STATES), { message: `state debe ser uno o varios de: ${MOVEMENT_STATES.join(', ')}` })
	@IsOptional()
	state?: string;

	@ApiPropertyOptional({ description: `Confianza de la sugerencia persistida (${CONFIDENCE_FILTERS.join(', ')})` })
	@Matches(list(CONFIDENCE_FILTERS), { message: `confidence debe ser uno o varios de: ${CONFIDENCE_FILTERS.join(', ')}` })
	@IsOptional()
	confidence?: string;

	@ApiPropertyOptional({ enum: RECONCILIATION_KPIS, description: 'KPI como filtro' })
	@IsIn(RECONCILIATION_KPIS, { message: `kpi debe ser uno de: ${RECONCILIATION_KPIS.join(', ')}` })
	@IsOptional()
	kpi?: ReconciliationKpi;

	@ApiPropertyOptional({ description: 'Mostrar cargos (egresos)' })
	@Transform(bool)
	@IsBoolean({ message: 'include_debits debe ser true o false' })
	@IsOptional()
	include_debits?: boolean;

	@ApiPropertyOptional({ description: 'Búsqueda: glosa, referencia, pagador, RUT o monto' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	q?: string;

	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 50, maximum: 200 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200, { message: 'limit máximo 200' })
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({ enum: ['date', 'amount'], default: 'date' })
	@IsIn(['date', 'amount'], { message: 'sortBy debe ser date o amount' })
	@IsOptional()
	sortBy?: 'date' | 'amount';

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';

	@ApiPropertyOptional({ default: 1, minimum: 0, maximum: 10 })
	@Type(() => Number)
	@IsNumber()
	@Min(0)
	@Max(10, { message: 'fee_threshold_pct máximo 10' })
	@IsOptional()
	fee_threshold_pct?: number;
}

export class ReconciliationCandidatesQueryDto {
	@ApiPropertyOptional({ description: 'Folio, cliente, razón social o RUT' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	q?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'client_id debe ser un UUID' })
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional({ description: 'Moneda de la factura (ISO 4217)' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'currency debe ser un código de 3 letras' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ default: 20, maximum: 50 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(50, { message: 'limit máximo 50' })
	@IsOptional()
	limit?: number;
}

// ---------------------------------------------------------------- cartolas

const COLUMN = { maxLength: 200 };

export class StatementMappingDto {
	@ApiProperty({ description: 'Encabezado de la columna de fecha' })
	@IsString()
	@MaxLength(COLUMN.maxLength)
	date_column!: string;

	@ApiProperty()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	description_column!: string;

	@ApiPropertyOptional({ description: 'Monto con signo (o bien debit_column/credit_column)' })
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	amount_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	debit_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	credit_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	currency_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	reference_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	tax_id_column?: string | null;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(COLUMN.maxLength)
	@IsOptional()
	balance_column?: string | null;

	@ApiPropertyOptional({ description: 'Moneda por defecto (si no, la de la cuenta)' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'default_currency debe ser un código de 3 letras' })
	@IsOptional()
	default_currency?: string | null;

	@ApiProperty({ enum: DATE_FORMATS })
	@IsIn(DATE_FORMATS, { message: `date_format debe ser uno de: ${DATE_FORMATS.join(', ')}` })
	date_format!: DateFormat;

	@ApiProperty({ enum: DECIMAL_SEPARATORS })
	@IsIn(DECIMAL_SEPARATORS, { message: 'decimal_separator debe ser , o .' })
	decimal_separator!: (typeof DECIMAL_SEPARATORS)[number];

	@ApiProperty({ enum: THOUSANDS_SEPARATORS })
	@IsIn(THOUSANDS_SEPARATORS, { message: 'thousands_separator debe ser ., ,, espacio o none' })
	thousands_separator!: (typeof THOUSANDS_SEPARATORS)[number];

	@ApiProperty({ enum: SIGN_CONVENTIONS })
	@IsIn(SIGN_CONVENTIONS, { message: 'amount_sign_convention debe ser credit_positive o credit_negative' })
	amount_sign_convention!: (typeof SIGN_CONVENTIONS)[number];

	@ApiPropertyOptional({ minimum: 0, maximum: 100 })
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(100)
	@IsOptional()
	skip_rows?: number | null;

	@ApiPropertyOptional({ maxLength: 120 })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	bank_name?: string | null;
}

export class StatementPreviewDto {
	@ApiProperty({ description: 'Cuenta bancaria del holding (obligatoria): fija compañía y moneda por defecto' })
	@IsUUID(undefined, { message: 'Elige la cuenta bancaria' })
	bank_account_id!: string;

	@ApiProperty({ maxLength: 255 })
	@Transform(trim)
	@IsString()
	@Matches(/\S/, { message: 'Indica el nombre del archivo' })
	@MaxLength(255)
	file_name!: string;

	@ApiProperty({ description: 'Hash del archivo (solo avisa si ya se importó)', maxLength: 128 })
	@IsString()
	@MaxLength(128)
	file_hash!: string;

	@ApiProperty({ enum: STATEMENT_FORMATS })
	@IsIn(STATEMENT_FORMATS, { message: 'format debe ser csv o xlsx' })
	format!: (typeof STATEMENT_FORMATS)[number];

	@ApiProperty({ type: [String], description: 'Encabezados (≤ 200)' })
	@IsArray()
	@ArrayMinSize(1, { message: 'El archivo no tiene encabezados' })
	@ArrayMaxSize(200)
	@IsString({ each: true })
	@MaxLength(200, { each: true })
	headers!: string[];

	@ApiProperty({ description: `Filas crudas (≤ ${STATEMENT_MAX_ROWS}); celdas texto o número`, type: 'array', items: { type: 'array' } })
	@IsArray()
	@ArrayMinSize(1, { message: 'El archivo no tiene filas' })
	@ArrayMaxSize(STATEMENT_MAX_ROWS, { message: `Máximo ${STATEMENT_MAX_ROWS} filas por archivo` })
	@IsArray({ each: true, message: 'Cada fila debe ser una lista de celdas' })
	@ArrayMaxSize(200, { each: true })
	rows!: Array<Array<string | number | null>>;

	@ApiProperty({ type: StatementMappingDto })
	@ValidateNested()
	@Type(() => StatementMappingDto)
	mapping!: StatementMappingDto;
}

export class SaveTemplateDto {
	@ApiProperty({ maxLength: 120 })
	@Transform(trim)
	@IsString()
	@Matches(/\S/, { message: 'Indica el banco' })
	@MaxLength(120)
	bank_name!: string;

	@ApiProperty({ maxLength: 120 })
	@Transform(trim)
	@IsString()
	@Matches(/\S/, { message: 'Indica el nombre de la plantilla' })
	@MaxLength(120)
	mapping_name!: string;

	@ApiPropertyOptional()
	@IsBoolean()
	@IsOptional()
	is_default?: boolean;
}

export class StatementImportDto extends StatementPreviewDto {
	@ApiPropertyOptional({ type: SaveTemplateDto, description: 'Guardar el mapeo como plantilla del banco' })
	@ValidateNested()
	@Type(() => SaveTemplateDto)
	@IsOptional()
	save_template?: SaveTemplateDto;
}

export class StatementsListQueryDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 20, maximum: 200 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200, { message: 'limit máximo 200' })
	@IsOptional()
	limit?: number;
}

export class ReasonDto {
	@ApiProperty({ maxLength: 500 })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@Matches(/\S/, { message: 'Escribe el motivo' })
	@MaxLength(500)
	reason!: string;
}

export class RevertStatementDto extends ReasonDto {}
export class UndoMatchDto extends ReasonDto {}

/** Ignorar / "No es una factura": motivo obligatorio (préstamo, aporte, traspaso entre cuentas, devolución u otro). */
export class IgnoreMovementDto extends ReasonDto {}

export class ReopenMovementDto {
	@ApiPropertyOptional({ maxLength: 500 })
	@Transform(trim)
	@IsString()
	@MaxLength(500)
	@IsOptional()
	reason?: string;
}

export class ReconciliationTemplateDto extends SaveTemplateDto {
	@ApiProperty({ type: StatementMappingDto })
	@ValidateNested()
	@Type(() => StatementMappingDto)
	column_mapping!: StatementMappingDto;
}

// ---------------------------------------------------------------- conciliar

export class MatchAllocationDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Factura inválida' })
	invoice_id!: string;

	@ApiProperty({ description: 'Monto en la moneda de la factura (> 0)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto inválido' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount!: number;

	@ApiPropertyOptional({ description: 'Monto en la moneda del movimiento (solo moneda distinta)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto original inválido' })
	@Min(0.01, { message: 'El monto original debe ser mayor que 0' })
	@IsOptional()
	original_amount?: number;
}

export class MatchFxDto {
	@ApiProperty({ description: 'Unidades de moneda de la factura por 1 de la moneda del movimiento' })
	@IsNumber({}, { message: 'Tipo de cambio inválido' })
	@IsPositive({ message: 'El tipo de cambio debe ser mayor que 0' })
	rate!: number;
}

export class MatchAdjustmentDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'Factura inválida' })
	invoice_id!: string;

	@ApiProperty({ description: 'Monto en la moneda de la factura (> 0)' })
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto inválido' })
	@Min(0.01, { message: 'El monto debe ser mayor que 0' })
	amount!: number;

	@ApiProperty({ enum: SETTLEMENT_REASONS, description: 'Un descuento comercial no es un motivo: va por NC' })
	@IsIn(SETTLEMENT_REASONS, { message: `reason debe ser uno de: ${SETTLEMENT_REASONS.join(', ')}` })
	reason!: SettlementReason;

	@ApiPropertyOptional({ maxLength: 500, description: 'Obligatoria con reason = other' })
	@Transform(trim)
	@IsString()
	@MaxLength(500)
	@IsOptional()
	note?: string;
}

export class MatchItemDto {
	@ApiPropertyOptional({ maxLength: 200, description: 'Clave del ítem (la de la sugerencia o una del front)' })
	@IsString()
	@MaxLength(200)
	@IsOptional()
	key?: string;

	@ApiProperty({ type: [String], description: '1 a 20 movimientos (más de uno = muchos-a-1)' })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica el movimiento' })
	@ArrayMaxSize(20, { message: 'Máximo 20 movimientos por ítem' })
	@IsUUID(undefined, { each: true, message: 'Movimiento inválido' })
	movement_ids!: string[];

	@ApiProperty({ type: [MatchAllocationDto], description: 'Hasta 100 facturas (efectivo)' })
	@IsArray()
	@ArrayMaxSize(100, { message: 'Máximo 100 facturas por ítem' })
	@ValidateNested({ each: true })
	@Type(() => MatchAllocationDto)
	allocations!: MatchAllocationDto[];

	@ApiPropertyOptional({ type: MatchFxDto })
	@ValidateNested()
	@Type(() => MatchFxDto)
	@IsOptional()
	fx?: MatchFxDto;

	@ApiPropertyOptional({ type: [MatchAdjustmentDto], description: 'Ajustes no monetarios (diferencia con motivo)' })
	@IsArray()
	@ArrayMaxSize(100)
	@ValidateNested({ each: true })
	@Type(() => MatchAdjustmentDto)
	@IsOptional()
	adjustments?: MatchAdjustmentDto[];

	@ApiPropertyOptional({ description: 'Permite facturas de distintos clientes (solo a mano; queda como aviso)' })
	@IsBoolean()
	@IsOptional()
	allow_multiple_clients?: boolean;

	@ApiPropertyOptional({ enum: ['suggestion', 'manual'] })
	@IsIn(['suggestion', 'manual'])
	@IsOptional()
	source?: 'suggestion' | 'manual';

	@ApiPropertyOptional({ enum: MATCH_CONFIDENCES })
	@IsIn(MATCH_CONFIDENCES)
	@IsOptional()
	confidence?: (typeof MATCH_CONFIDENCES)[number];

	@ApiPropertyOptional({ minimum: 0, maximum: 100 })
	@IsNumber()
	@Min(0)
	@Max(100)
	@IsOptional()
	score?: number;
}

export class MatchesDto {
	@ApiProperty({ type: [MatchItemDto], description: '1 a 200 ítems (todo o nada por ítem, ítems independientes)' })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un ítem' })
	@ArrayMaxSize(200, { message: 'Máximo 200 ítems por operación' })
	@ValidateNested({ each: true })
	@Type(() => MatchItemDto)
	items!: MatchItemDto[];
}

export class RefreshSuggestionsDto extends FeeThresholdDto {}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
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
	MinLength,
	ValidateNested,
} from 'class-validator';

import { BUDGET_DIMENSION_TYPES, type BudgetDimensionType } from '@/databases/postgresql/entities/revenue/budget-line.entity';
import {
	BUDGET_GRANULARITIES,
	BUDGET_KINDS,
	BUDGET_SCENARIOS,
	type BudgetGranularity,
	type BudgetKind,
	type BudgetScenario,
} from '@/databases/postgresql/entities/revenue/budget.entity';

import { BUDGET_KEY_MAX, BUDGET_LINES_MAX } from '../budgets-rules';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Estados que se pueden escribir con el PUT (archivar va por su ruta). */
export const BUDGET_WRITABLE_STATUSES = ['draft', 'active'] as const;

/** `GET /budgets`: filtros opcionales por tipo y año. */
export class BudgetsQueryDto {
	@ApiPropertyOptional({ enum: BUDGET_KINDS })
	@IsIn(BUDGET_KINDS, { message: `kind debe ser uno de: ${BUDGET_KINDS.join(', ')}` })
	@IsOptional()
	kind?: BudgetKind;

	@ApiPropertyOptional({ description: 'Año fiscal (= año calendario)' })
	@Type(() => Number)
	@IsInt({ message: 'fiscal_year debe ser un año' })
	@Min(2000, { message: 'fiscal_year debe ser un año' })
	@Max(2100, { message: 'fiscal_year debe ser un año' })
	@IsOptional()
	fiscal_year?: number;
}

/** Una celda del presupuesto. */
export class BudgetLineDto {
	@ApiProperty({ description: 'Primer día del período (mes, trimestre o año según la granularidad) YYYY-MM-DD' })
	@Matches(ISO_DATE, { message: 'period_start debe ser YYYY-MM-DD' })
	period_start!: string;

	@ApiPropertyOptional({ enum: BUDGET_DIMENSION_TYPES, default: 'total' })
	@IsIn(BUDGET_DIMENSION_TYPES, { message: `dimension_type debe ser uno de: ${BUDGET_DIMENSION_TYPES.join(', ')}` })
	@IsOptional()
	dimension_type?: BudgetDimensionType;

	@ApiPropertyOptional({ nullable: true, description: 'company, seller, product, client: id de la entidad' })
	@IsUUID(undefined, { message: 'dimension_id debe ser un UUID' })
	@IsOptional()
	dimension_id?: string | null;

	@ApiPropertyOptional({ nullable: true, description: 'segment, market: valor del cliente' })
	@Transform(trim)
	@IsString({ message: 'dimension_key debe ser texto' })
	@MinLength(1, { message: 'dimension_key no puede estar vacío' })
	@MaxLength(BUDGET_KEY_MAX)
	@IsOptional()
	dimension_key?: string | null;

	@ApiProperty({ description: 'Monto (≥ 0, 2 decimales) en la moneda del presupuesto (moneda de sistema)' })
	@IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }, { message: 'Monto inválido (hasta 2 decimales)' })
	@Min(0, { message: 'El monto no puede ser negativo' })
	@Max(1e15, { message: 'Monto inválido' })
	amount!: number;
}

/** `PUT /budgets`: crea o reemplaza el presupuesto vivo de (kind, fiscal_year, scenario) con todas sus líneas. */
export class UpsertBudgetDto {
	@ApiProperty({ enum: BUDGET_KINDS })
	@IsIn(BUDGET_KINDS, { message: `kind debe ser uno de: ${BUDGET_KINDS.join(', ')}` })
	kind!: BudgetKind;

	@ApiProperty({ description: 'Año fiscal (= año calendario)' })
	@IsInt({ message: 'fiscal_year debe ser un año' })
	@Min(2000, { message: 'fiscal_year debe ser un año' })
	@Max(2100, { message: 'fiscal_year debe ser un año' })
	fiscal_year!: number;

	@ApiPropertyOptional({ enum: BUDGET_SCENARIOS, default: 'base' })
	@IsIn(BUDGET_SCENARIOS, { message: `scenario debe ser uno de: ${BUDGET_SCENARIOS.join(', ')}` })
	@IsOptional()
	scenario?: BudgetScenario;

	@ApiProperty({ description: 'Nombre visible' })
	@Transform(trim)
	@IsString({ message: 'Indica el nombre' })
	@MinLength(1, { message: 'Indica el nombre' })
	@MaxLength(160)
	name!: string;

	@ApiPropertyOptional({ enum: BUDGET_GRANULARITIES, default: 'month' })
	@IsIn(BUDGET_GRANULARITIES, { message: `period_granularity debe ser uno de: ${BUDGET_GRANULARITIES.join(', ')}` })
	@IsOptional()
	period_granularity?: BudgetGranularity;

	@ApiPropertyOptional({ enum: BUDGET_WRITABLE_STATUSES, default: 'active' })
	@IsIn(BUDGET_WRITABLE_STATUSES, { message: 'status debe ser draft o active (archivar: POST /budgets/:id/archive)' })
	@IsOptional()
	status?: (typeof BUDGET_WRITABLE_STATUSES)[number];

	@ApiPropertyOptional({ nullable: true })
	@Transform(trim)
	@IsString()
	@MaxLength(2000)
	@IsOptional()
	notes?: string | null;

	@ApiProperty({ type: [BudgetLineDto], description: `Todas las celdas (reemplazan a las anteriores; máximo ${BUDGET_LINES_MAX})` })
	@IsArray({ message: 'lines debe ser una lista' })
	@ArrayMaxSize(BUDGET_LINES_MAX, { message: `Un presupuesto admite hasta ${BUDGET_LINES_MAX} líneas` })
	@ValidateNested({ each: true })
	@Type(() => BudgetLineDto)
	lines!: BudgetLineDto[];
}

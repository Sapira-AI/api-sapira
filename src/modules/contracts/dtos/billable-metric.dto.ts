import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import {
	BILLABLE_METRIC_AGGREGATIONS,
	BILLABLE_METRIC_SOURCE_KINDS,
	type BillableMetricAggregation,
	type BillableMetricSourceKind,
} from '@/databases/postgresql/entities/contratos/billable-metric.entity';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const slug = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** Body de `POST /billable-metrics` (Pricing v2 §2.1 y §5). El holding sale del guard. */
export class CreateBillableMetricDto {
	@ApiProperty({ description: 'Slug estable para API y DWH, único por holding (a-z, 0-9, guion y guion bajo)', example: 'rutas_completadas' })
	@Transform(slug)
	@Matches(/^[a-z0-9][a-z0-9_-]*$/, { message: 'El código solo admite minúsculas, números, guion y guion bajo' })
	@MinLength(2, { message: 'El código necesita al menos 2 caracteres' })
	@MaxLength(64, { message: 'Código: máximo 64 caracteres' })
	@IsString({ message: 'Escribe el código de la métrica' })
	code!: string;

	@ApiProperty({ example: 'Rutas completadas' })
	@Transform(trim)
	@MaxLength(120, { message: 'Nombre: máximo 120 caracteres' })
	@MinLength(1, { message: 'Escribe el nombre de la métrica' })
	@IsString({ message: 'Escribe el nombre de la métrica' })
	name!: string;

	@ApiPropertyOptional()
	@IsString({ message: 'Descripción inválida' })
	@MaxLength(2000, { message: 'Descripción: máximo 2.000 caracteres' })
	@IsOptional()
	description?: string;

	@ApiProperty({ enum: BILLABLE_METRIC_AGGREGATIONS })
	@IsIn(BILLABLE_METRIC_AGGREGATIONS, { message: 'Elige cómo se agrega la métrica: suma, conteo, máximo, mínimo, último o únicos' })
	aggregation!: BillableMetricAggregation;

	@ApiProperty({ description: 'Unidad en singular para glosa y UI', example: 'ruta' })
	@Transform(trim)
	@MaxLength(32, { message: 'Unidad: máximo 32 caracteres' })
	@MinLength(1, { message: 'Escribe la unidad de la métrica' })
	@IsString({ message: 'Escribe la unidad de la métrica' })
	unit!: string;

	@ApiPropertyOptional({
		enum: BILLABLE_METRIC_SOURCE_KINDS,
		default: 'manual',
		description: 'Hoy solo manual es funcional (dwh/api llegan con el canal DWH)',
	})
	@IsIn(BILLABLE_METRIC_SOURCE_KINDS, { message: 'Elige la fuente: manual, csv, dwh o api' })
	@IsOptional()
	source_kind?: BillableMetricSourceKind;

	@ApiPropertyOptional({ type: Object, description: 'Para dwh: referencia a la consulta/tabla de BigQuery; para el resto {}' })
	@IsObject({ message: 'Configuración de fuente inválida' })
	@IsOptional()
	source_config?: Record<string, unknown>;
}

/** Body de `PATCH /billable-metrics/:id`: todo opcional; el código no cambia (es la clave estable de API y DWH). */
export class UpdateBillableMetricDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@MaxLength(120, { message: 'Nombre: máximo 120 caracteres' })
	@MinLength(1, { message: 'Escribe el nombre de la métrica' })
	@IsString({ message: 'Nombre inválido' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ nullable: true })
	@IsString({ message: 'Descripción inválida' })
	@MaxLength(2000, { message: 'Descripción: máximo 2.000 caracteres' })
	@IsOptional()
	description?: string | null;

	@ApiPropertyOptional({ enum: BILLABLE_METRIC_AGGREGATIONS })
	@IsIn(BILLABLE_METRIC_AGGREGATIONS, { message: 'Elige cómo se agrega la métrica: suma, conteo, máximo, mínimo, último o únicos' })
	@IsOptional()
	aggregation?: BillableMetricAggregation;

	@ApiPropertyOptional()
	@Transform(trim)
	@MaxLength(32, { message: 'Unidad: máximo 32 caracteres' })
	@MinLength(1, { message: 'Escribe la unidad de la métrica' })
	@IsString({ message: 'Unidad inválida' })
	@IsOptional()
	unit?: string;

	@ApiPropertyOptional({ enum: BILLABLE_METRIC_SOURCE_KINDS })
	@IsIn(BILLABLE_METRIC_SOURCE_KINDS, { message: 'Elige la fuente: manual, csv, dwh o api' })
	@IsOptional()
	source_kind?: BillableMetricSourceKind;

	@ApiPropertyOptional({ type: Object })
	@IsObject({ message: 'Configuración de fuente inválida' })
	@IsOptional()
	source_config?: Record<string, unknown>;
}

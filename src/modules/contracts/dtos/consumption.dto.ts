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
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { APPLY_AS_MODES, type ApplyAsMode, ON_ISSUED_MODES, type OnIssuedMode } from '../consumption';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Máximo de filas por importación masiva (`POST /contracts/:id/consumption/bulk`). */
export const CONSUMPTION_BULK_MAX = 500;

/**
 * Body de `PUT /contracts/:id/items/:itemId/consumption/:periodStart` y de `POST /contracts/:id/consumption/preview`
 * (Pricing v2 §5). Upsert idempotente: si el período ya tiene consumo, `correction_reason` es obligatorio (revisión 2+).
 */
export class UpsertConsumptionDto {
	@ApiProperty({ description: 'Valor agregado de la métrica en el período (0 = sin consumo: la línea queda en 0)', example: 1250 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe la cantidad del período' })
	@Min(0, { message: 'La cantidad no puede ser negativa' })
	quantity!: number;

	@ApiPropertyOptional({
		description: 'Monto final informado por el cliente: la línea usa este monto y la cantidad queda informativa',
		nullable: true,
	})
	@ValidateIf((_dto: UpsertConsumptionDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto informado inválido' })
	@Min(0, { message: 'El monto informado no puede ser negativo' })
	amount_override?: number | null;

	@ApiPropertyOptional({ default: true, description: 'Aplicar el descuento del ítem sobre el consumo (S7-9); false = "es el monto final"' })
	@IsBoolean({ message: 'Indica si se aplica el descuento del ítem' })
	@IsOptional()
	apply_item_discount?: boolean;

	@ApiPropertyOptional({ description: 'Cuenta del período si difiere de la del ítem' })
	@Transform(trim)
	@IsString({ message: 'Cuenta inválida' })
	@MaxLength(128, { message: 'Cuenta: máximo 128 caracteres' })
	@IsOptional()
	account?: string;

	@ApiPropertyOptional({ default: false, description: 'true = valor estimado al cierre; se reemplaza al llegar el real' })
	@IsBoolean({ message: 'Indica si el valor es estimado' })
	@IsOptional()
	is_estimated?: boolean;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(2000, { message: 'Las notas no pueden superar 2.000 caracteres' })
	@IsOptional()
	notes?: string;

	@ApiPropertyOptional({ description: 'Motivo de la corrección; obligatorio si el período ya tenía consumo' })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo de la corrección' })
	@MaxLength(500, { message: 'El motivo no puede superar 500 caracteres' })
	@IsOptional()
	correction_reason?: string;

	@ApiPropertyOptional({ description: 'Clave de idempotencia (única por holding): reenviar con la misma clave no duplica ni corrige' })
	@Transform(trim)
	@IsString({ message: 'Clave de idempotencia inválida' })
	@MaxLength(200, { message: 'La clave de idempotencia no puede superar 200 caracteres' })
	@IsOptional()
	idempotency_key?: string;

	@ApiPropertyOptional({
		enum: APPLY_AS_MODES,
		default: 'recompute',
		description:
			'Cómo aplicar la cantidad a la factura del período (spec §4.4). recompute (default) = recalcula la Por Emitir; con la factura emitida → 409 explicado (consumption_period_issued, o item_not_metered en ítems estándar). additional = la factura del período (Por Emitir o emitida) no se toca y se crea una complementaria Por Emitir con fecha de hoy y UNA línea por la diferencia. reissue = NC espejo de la emitida + factura nueva Por Emitir del período con la cantidad corregida (con la Por Emitir equivale a recompute). Nunca se toca una emitida',
	})
	@IsIn(APPLY_AS_MODES, { message: 'apply_as debe ser recompute, additional o reissue' })
	@IsOptional()
	apply_as?: ApplyAsMode;

	@ApiPropertyOptional({
		enum: ON_ISSUED_MODES,
		deprecated: true,
		description: 'Alias histórico de `apply_as` (block = recompute). Si vienen los dos, manda `apply_as`. La respuesta devuelve ambos',
	})
	@IsIn(ON_ISSUED_MODES, { message: 'on_issued debe ser block, additional o reissue' })
	@IsOptional()
	on_issued?: OnIssuedMode;
}

/** Fila de la importación masiva: ítem por id o por producto + cuenta, más el período y la cantidad. */
export class ConsumptionBulkRowDto {
	@ApiPropertyOptional({ description: 'Ítem del contrato (si se omite, se resuelve por product_name + account)' })
	@IsUUID(undefined, { message: 'Ítem inválido' })
	@IsOptional()
	item_id?: string;

	@ApiPropertyOptional({ description: 'Nombre del producto del ítem (con `account`), cuando no viene `item_id`' })
	@Transform(trim)
	@IsString({ message: 'Producto inválido' })
	@MaxLength(200, { message: 'Producto: máximo 200 caracteres' })
	@IsOptional()
	product_name?: string;

	@ApiPropertyOptional({ description: 'Cuenta del ítem (con `product_name`); vacío = ítem sin cuenta' })
	@Transform(trim)
	@IsString({ message: 'Cuenta inválida' })
	@MaxLength(128, { message: 'Cuenta: máximo 128 caracteres' })
	@IsOptional()
	account?: string;

	@ApiProperty({ example: '2026-10-01', description: 'Inicio del período de servicio de la línea' })
	@Matches(ISO_DATE, { message: 'Período inválido (YYYY-MM-DD)' })
	period_start!: string;

	@ApiProperty({ example: 1250 })
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Cantidad inválida' })
	@Min(0, { message: 'La cantidad no puede ser negativa' })
	quantity!: number;

	@ApiPropertyOptional({ nullable: true })
	@ValidateIf((_row: ConsumptionBulkRowDto, value: unknown) => value !== null && value !== undefined)
	@IsNumber({ maxDecimalPlaces: 2 }, { message: 'Monto informado inválido' })
	@Min(0, { message: 'El monto informado no puede ser negativo' })
	amount_override?: number | null;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(2000, { message: 'Las notas no pueden superar 2.000 caracteres' })
	@IsOptional()
	notes?: string;

	@ApiPropertyOptional({ description: 'Motivo si el período ya tenía consumo' })
	@Transform(trim)
	@IsString({ message: 'Motivo inválido' })
	@MaxLength(500, { message: 'El motivo no puede superar 500 caracteres' })
	@IsOptional()
	correction_reason?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Clave de idempotencia inválida' })
	@MaxLength(200, { message: 'La clave de idempotencia no puede superar 200 caracteres' })
	@IsOptional()
	idempotency_key?: string;
}

/** Body de `POST /contracts/:id/consumption/bulk` (desde CSV): 1–500 filas, una transacción por fila. */
export class ConsumptionBulkDto {
	@ApiProperty({ type: [ConsumptionBulkRowDto] })
	@IsArray({ message: 'Agrega al menos una fila' })
	@ArrayMinSize(1, { message: 'Agrega al menos una fila' })
	@ArrayMaxSize(CONSUMPTION_BULK_MAX, { message: `Máximo ${CONSUMPTION_BULK_MAX} filas por importación` })
	@ValidateNested({ each: true })
	@Type(() => ConsumptionBulkRowDto)
	rows!: ConsumptionBulkRowDto[];
}

/** Query de `GET /consumption/pending` y `GET /contracts/:id/consumption/pending`. */
export class QueryConsumptionPendingDto {
	@ApiPropertyOptional({ example: '2026-10', description: 'Mes del inicio del período de servicio (YYYY-MM)' })
	@Matches(YEAR_MONTH, { message: 'Período inválido (YYYY-MM)' })
	@IsOptional()
	period?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Cliente inválido' })
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional()
	@IsUUID(undefined, { message: 'Compañía inválida' })
	@IsOptional()
	company_id?: string;

	@ApiPropertyOptional({ description: 'Acotar a un contrato (equivale a GET /contracts/:id/consumption/pending)' })
	@IsUUID(undefined, { message: 'Contrato inválido' })
	@IsOptional()
	contract_id?: string;

	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt({ message: 'Página inválida' })
	@Min(1, { message: 'Página inválida' })
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25 })
	@Type(() => Number)
	@IsInt({ message: 'Límite inválido' })
	@Min(1, { message: 'Límite inválido' })
	@Max(200, { message: 'Máximo 200 por página' })
	@IsOptional()
	limit?: number;
}

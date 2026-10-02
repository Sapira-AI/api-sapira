import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

/**
 * Ajustes pactados (`contract_scheduled_changes`, spec modificaciones §9.3.6 y `spec-renovacion-y-ajustes-pactados.md` §3). Mismo DTO en el
 * alta (`CreateContractDto.scheduled_changes[]`, con `item_key`) y en `POST /contracts/:id/scheduled-changes` (con `contract_item_id`).
 */
export const SCHEDULED_CHANGE_TRIGGERS = ['on_renewal', 'on_date', 'every_n_months'] as const;
export type ScheduledChangeTrigger = (typeof SCHEDULED_CHANGE_TRIGGERS)[number];
export const SCHEDULED_CHANGE_KINDS = ['percent_uplift', 'index', 'new_unit_price', 'quantity', 'term', 'billing_frequency'] as const;
export type ScheduledChangeKind = (typeof SCHEDULED_CHANGE_KINDS)[number];
export const SCHEDULED_CHANGE_ROUNDINGS = ['none', 'unit_2', 'unit_0', 'monthly_0'] as const;
export type ScheduledChangeRounding = (typeof SCHEDULED_CHANGE_ROUNDINGS)[number];
export const SCHEDULED_CHANGE_STATUSES = ['scheduled', 'applied', 'skipped', 'cancelled'] as const;
export type ScheduledChangeStatus = (typeof SCHEDULED_CHANGE_STATUSES)[number];

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown) => value !== null && value !== undefined;

export class CreateScheduledChangeDto {
	@ApiPropertyOptional({ description: 'Ítem del contrato (null = alcance contrato: todos los recurrentes vigentes al aplicar)' })
	@IsUUID(undefined, { message: 'Ítem inválido' })
	@IsOptional()
	contract_item_id?: string | null;

	@ApiPropertyOptional({ description: 'Alta del contrato: `key` del ítem del formulario al que aplica (en vez de contract_item_id)' })
	@IsString({ message: 'Ítem inválido' })
	@MaxLength(80)
	@IsOptional()
	item_key?: string;

	@ApiPropertyOptional({ description: 'Varios cambios del mismo acto (misma fecha) comparten la clave' })
	@IsUUID(undefined, { message: 'Grupo inválido' })
	@IsOptional()
	group_key?: string;

	@ApiProperty({ enum: SCHEDULED_CHANGE_TRIGGERS })
	@IsIn(SCHEDULED_CHANGE_TRIGGERS, { message: 'Disparo inválido: on_renewal, on_date o every_n_months' })
	trigger!: ScheduledChangeTrigger;

	@ApiPropertyOptional({ description: 'Obligatoria con on_date' })
	@ValidateIf((dto: CreateScheduledChangeDto) => dto.trigger === 'on_date' || present(dto.effective_date))
	@Matches(ISO_DATE, { message: 'Fecha del pacto inválida (YYYY-MM-DD)' })
	effective_date?: string | null;

	@ApiPropertyOptional({ description: 'Obligatoria con every_n_months: primera fecha de aplicación' })
	@ValidateIf((dto: CreateScheduledChangeDto) => dto.trigger === 'every_n_months' || present(dto.anchor_date))
	@Matches(ISO_DATE, { message: 'Fecha de inicio del pacto inválida (YYYY-MM-DD)' })
	anchor_date?: string | null;

	@ApiPropertyOptional({ description: 'Obligatorio con every_n_months (p. ej. 12 = anual)' })
	@ValidateIf((dto: CreateScheduledChangeDto) => dto.trigger === 'every_n_months' || present(dto.interval_months))
	@IsInt({ message: 'El intervalo va en meses enteros' })
	@Min(1, { message: 'El intervalo mínimo es 1 mes' })
	@Max(120, { message: 'El intervalo máximo es 120 meses' })
	interval_months?: number | null;

	@ApiProperty({ enum: SCHEDULED_CHANGE_KINDS })
	@IsIn(SCHEDULED_CHANGE_KINDS, { message: 'Tipo de pacto inválido' })
	kind!: ScheduledChangeKind;

	@ApiProperty({
		description:
			'% (percent_uplift; en index = puntos sobre la variación del índice, 0 = solo el índice), precio en moneda del ítem, cantidad o meses según kind',
	})
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Escribe el valor del pacto' })
	value!: number;

	@ApiPropertyOptional({ description: 'Obligatorio con kind = index: código de `indicadores_economicos` (IPC, UF, USD)' })
	@ValidateIf((dto: CreateScheduledChangeDto) => dto.kind === 'index' || present(dto.index_code))
	@Transform(trim)
	@IsString({ message: 'Indica el índice' })
	@MinLength(1, { message: 'Indica el índice' })
	@MaxLength(80)
	index_code?: string | null;

	@ApiPropertyOptional()
	@ValidateIf((_dto: CreateScheduledChangeDto, value: unknown) => present(value))
	@Matches(ISO_DATE, { message: 'Fecha base del índice inválida' })
	index_base_date?: string | null;

	@ApiPropertyOptional({ description: 'Obligatorio con kind = index: valor del índice al pactar' })
	@ValidateIf((dto: CreateScheduledChangeDto) => dto.kind === 'index' || present(dto.index_base_value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Valor base del índice inválido' })
	@Min(0.000001, { message: 'El valor base del índice debe ser mayor que 0' })
	index_base_value?: number | null;

	@ApiPropertyOptional({ default: 1 })
	@IsInt({ message: 'El desfase va en meses enteros' })
	@Min(0)
	@Max(24)
	@IsOptional()
	index_lag_months?: number;

	@ApiPropertyOptional({ enum: SCHEDULED_CHANGE_ROUNDINGS, default: 'unit_2' })
	@IsIn(SCHEDULED_CHANGE_ROUNDINGS, { message: 'Redondeo inválido: none, unit_2, unit_0 o monthly_0' })
	@IsOptional()
	rounding?: ScheduledChangeRounding;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(2000)
	@IsOptional()
	notes?: string | null;
}

/** `PATCH /contracts/:id/scheduled-changes/:changeId` (solo `scheduled`). */
export class UpdateScheduledChangeDto extends PartialType(OmitType(CreateScheduledChangeDto, ['item_key'] as const)) {}

/** `POST …/:changeId/skip` y `…/cancel`. */
export class ScheduledChangeReasonDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@MinLength(1, { message: 'Escribe el motivo' })
	@MaxLength(500)
	reason!: string;
}

/** `POST …/:changeId/apply/preview` y `…/apply`: materializa el pacto con el motor de `item_change` / `renewal`. */
export class ApplyScheduledChangeDto {
	@ApiPropertyOptional({
		description: 'Default: el próximo inicio de período del ítem en o después de la fecha del pacto (reajuste sin prorrateo)',
	})
	@Matches(ISO_DATE, { message: 'Fecha efectiva inválida (YYYY-MM-DD)' })
	@IsOptional()
	effective_date?: string;

	@ApiPropertyOptional({ description: 'Valor a usar en vez del pactado (queda en applied_value)' })
	@ValidateIf((_dto: ApplyScheduledChangeDto, value: unknown) => present(value))
	@IsNumber({ maxDecimalPlaces: 6 }, { message: 'Valor inválido' })
	value?: number | null;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Motivo inválido' })
	@MaxLength(500)
	@IsOptional()
	reason?: string;

	@ApiPropertyOptional()
	@IsString({ message: 'Notas inválidas' })
	@MaxLength(2000)
	@IsOptional()
	notes?: string;
}

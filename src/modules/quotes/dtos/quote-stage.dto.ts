import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsIn,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { QUOTE_STAGE_KINDS, type QuoteStageKind } from '../quote-status';

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Una etapa de `PUT /quote-stages`: con `id` se actualiza, sin `id` se crea; la posición es el orden del arreglo. */
export class QuoteStageInputDto {
	@ApiPropertyOptional({ description: 'Etapa existente del holding' })
	@IsUUID(undefined, { message: 'Etapa inválida' })
	@IsOptional()
	id?: string;

	@ApiProperty()
	@Transform(trim)
	@MaxLength(60, { message: 'Nombre de etapa: máximo 60 caracteres' })
	@MinLength(1, { message: 'Escribe el nombre de la etapa' })
	@IsString({ message: 'Escribe el nombre de la etapa' })
	name!: string;

	@ApiPropertyOptional({ example: '#3b82f6' })
	@Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Color inválido (hex #RRGGBB)' })
	@IsOptional()
	color?: string;

	@ApiProperty({ enum: QUOTE_STAGE_KINDS, description: 'Kind de sistema (Q-A1): draft, sent, signed, lost o contract_created' })
	@IsIn(QUOTE_STAGE_KINDS, { message: 'Elige el tipo de etapa: borrador, enviada, firmada, perdida o contrato creado' })
	kind!: QuoteStageKind;
}

/** Body de `PUT /quote-stages`: la lista completa y ordenada de etapas del holding (las ausentes se eliminan). */
export class UpdateQuoteStagesDto {
	@ApiProperty({ type: [QuoteStageInputDto] })
	@IsArray({ message: 'Agrega al menos una etapa' })
	@ArrayMinSize(1, { message: 'Agrega al menos una etapa' })
	@ArrayMaxSize(30, { message: 'Máximo 30 etapas' })
	@ValidateNested({ each: true })
	@Type(() => QuoteStageInputDto)
	stages!: QuoteStageInputDto[];
}

/** Body de `POST /quotes/:id/stage`: la etapa destino por id o por kind (la etapa del holding con ese kind). */
export class QuoteStageTransitionDto {
	@ApiPropertyOptional({ description: 'Etapa configurada del holding' })
	@ValidateIf((dto: QuoteStageTransitionDto) => dto.stage_id !== undefined || dto.kind === undefined)
	@IsUUID(undefined, { message: 'Elige la etapa destino (stage_id o kind)' })
	stage_id?: string;

	@ApiPropertyOptional({ enum: QUOTE_STAGE_KINDS, description: 'Kind destino; usa la (primera) etapa del holding con ese kind' })
	@ValidateIf((dto: QuoteStageTransitionDto) => dto.kind !== undefined)
	@IsIn(QUOTE_STAGE_KINDS, { message: 'Kind destino inválido' })
	kind?: QuoteStageKind;

	@ApiPropertyOptional({ description: 'Obligatoria al marcar firmada (Q-D6); default: la que ya tenga la cotización' })
	@Matches(ISO_DATE, { message: 'Fecha de cierre inválida' })
	@IsOptional()
	booking_date?: string;

	@ApiPropertyOptional({ description: 'Motivo (obligatorio al marcar perdida)' })
	@Transform(trim)
	@IsString({ message: 'Motivo inválido' })
	@MaxLength(500, { message: 'Motivo: máximo 500 caracteres' })
	@IsOptional()
	reason?: string;
}

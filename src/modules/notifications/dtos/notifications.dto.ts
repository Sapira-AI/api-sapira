import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	ArrayUnique,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateNested,
} from 'class-validator';

import { NOTIFICATION_MODULE_KEYS } from '../notification-catalog';

const SEVERITIES = ['info', 'warning', 'error'] as const;
const STATUSES = ['open', 'resolved'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `a,b` o el parámetro repetido → arreglo sin vacíos. */
const toList = ({ value }: { value: unknown }) =>
	value === undefined || value === null || value === ''
		? undefined
		: (Array.isArray(value) ? value : [value])
				.flatMap((item) => String(item).split(','))
				.map((item) => item.trim())
				.filter(Boolean);
const toBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

/** Filtros de la lista de notificaciones (también el cuerpo de `POST /notifications/read-all`). */
export class NotificationFiltersDto {
	@ApiPropertyOptional({ enum: STATUSES })
	@IsOptional()
	@IsIn(STATUSES, { message: 'Estado inválido: open o resolved' })
	status?: (typeof STATUSES)[number];

	@ApiPropertyOptional({ description: 'true = solo leídas; false = solo sin leer' })
	@IsOptional()
	@Transform(toBool)
	@IsBoolean({ message: 'read debe ser true o false' })
	read?: boolean;

	@ApiPropertyOptional({ description: 'false (por defecto) = bandeja; true = solo archivadas' })
	@IsOptional()
	@Transform(toBool)
	@IsBoolean({ message: 'archived debe ser true o false' })
	archived?: boolean;

	@ApiPropertyOptional({ type: [String], description: 'Tipos del catálogo (a,b)' })
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@ArrayMaxSize(30)
	@IsString({ each: true })
	@MaxLength(120, { each: true })
	type?: string[];

	@ApiPropertyOptional({ type: [String], enum: NOTIFICATION_MODULE_KEYS })
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@IsIn(NOTIFICATION_MODULE_KEYS, { each: true, message: `Módulo inválido: ${NOTIFICATION_MODULE_KEYS.join(', ')}` })
	module?: string[];

	@ApiPropertyOptional({ type: [String], enum: SEVERITIES })
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@IsIn(SEVERITIES, { each: true, message: 'Gravedad inválida: info, warning o error' })
	severity?: Array<(typeof SEVERITIES)[number]>;

	@ApiPropertyOptional({ example: '2026-10-01', description: 'Desde (fecha de creación, zona del holding)' })
	@IsOptional()
	@Matches(ISO_DATE, { message: 'Fecha "desde" inválida (AAAA-MM-DD)' })
	from?: string;

	@ApiPropertyOptional({ example: '2026-10-31', description: 'Hasta (inclusivo)' })
	@IsOptional()
	@Matches(ISO_DATE, { message: 'Fecha "hasta" inválida (AAAA-MM-DD)' })
	to?: string;

	@ApiPropertyOptional({ description: 'Busca en título y mensaje' })
	@IsOptional()
	@IsString()
	@MaxLength(120, { message: 'La búsqueda admite hasta 120 caracteres' })
	search?: string;
}

export class ListNotificationsDto extends NotificationFiltersDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number = 1;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100, { message: 'El límite máximo es 100' })
	limit?: number = 20;
}

export class NotificationIdsDto {
	@IsArray({ message: 'Indica las notificaciones' })
	@ArrayMinSize(1, { message: 'Indica al menos una notificación' })
	@ArrayMaxSize(200, { message: 'Hasta 200 notificaciones por vez' })
	@ArrayUnique()
	@IsUUID('all', { each: true, message: 'Identificador de notificación inválido' })
	ids!: string[];
}

export class NotificationTypePreferenceDto {
	@IsString()
	@MaxLength(120)
	type!: string;

	@IsOptional()
	@IsBoolean({ message: 'in_app debe ser true o false' })
	in_app?: boolean;

	@IsOptional()
	@IsBoolean({ message: 'email debe ser true o false' })
	email?: boolean;
}

export class UpdateNotificationPreferencesDto {
	@IsOptional()
	@IsBoolean({ message: 'weekly_digest debe ser true o false' })
	weekly_digest?: boolean;

	@IsOptional()
	@IsArray()
	@ArrayMaxSize(50)
	@ValidateNested({ each: true })
	@Type(() => NotificationTypePreferenceDto)
	types?: NotificationTypePreferenceDto[];
}

export class NotificationTasksQueryDto {
	@ApiPropertyOptional({ example: '2026-10-03' })
	@IsOptional()
	@Matches(ISO_DATE, { message: 'Fecha inválida (AAAA-MM-DD)' })
	as_of?: string;
}

export class ReplaceSalesforceStagingBlockedSubscriptionsDto {
	@IsOptional()
	@IsArray()
	@ArrayUnique()
	@IsUUID('4', { each: true })
	role_ids?: string[] = [];

	@IsOptional()
	@IsBoolean()
	include_super_admins?: boolean = false;
}

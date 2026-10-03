import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
	MinLength,
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

	@ApiPropertyOptional({ type: [String], description: '"Mis compañías": [] = todas' })
	@IsOptional()
	@IsArray({ message: 'company_ids debe ser una lista' })
	@ArrayMaxSize(100, { message: 'Hasta 100 compañías' })
	@ArrayUnique()
	@IsUUID('all', { each: true, message: 'Compañía inválida' })
	company_ids?: string[];
}

export class NotificationTasksQueryDto {
	@ApiPropertyOptional({ example: '2026-10-03' })
	@IsOptional()
	@Matches(ISO_DATE, { message: 'Fecha inválida (AAAA-MM-DD)' })
	as_of?: string;

	@ApiPropertyOptional({ type: [String], description: 'Compañías (a,b). Sin esto: "Mis compañías" del usuario' })
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@ArrayMaxSize(100)
	@IsUUID('all', { each: true, message: 'Compañía inválida' })
	company_ids?: string[];

	@ApiPropertyOptional({ description: 'true = todas las compañías (ignora "Mis compañías")' })
	@IsOptional()
	@Transform(toBool)
	@IsBoolean({ message: 'all debe ser true o false' })
	all?: boolean;
}

export class MentionableUsersQueryDto {
	@ApiPropertyOptional({ description: 'Busca por nombre o correo' })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	search?: string;

	@ApiPropertyOptional({ default: 20, maximum: 50 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(50, { message: 'El límite máximo es 50' })
	limit?: number;
}

export class SystemUpdateDto {
	@ApiProperty({ example: 'notificaciones-v2', description: 'Slug de la novedad en el Centro de ayuda (a-z, 0-9 y guiones)' })
	@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'El slug solo admite minúsculas, números y guiones' })
	@MaxLength(80, { message: 'El slug admite hasta 80 caracteres' })
	slug!: string;

	@ApiProperty({ example: 'Nuevo centro de notificaciones' })
	@IsString()
	@MinLength(1, { message: 'Escribe un título' })
	@MaxLength(120, { message: 'El título admite hasta 120 caracteres' })
	title!: string;

	@ApiProperty({ example: 'Tareas y alertas en un solo lugar, con resumen semanal por correo.' })
	@IsString()
	@MinLength(1, { message: 'Escribe un resumen' })
	@MaxLength(500, { message: 'El resumen admite hasta 500 caracteres' })
	summary!: string;
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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	IsUrl,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateNested,
} from 'class-validator';

import { IsIsoDate } from '@/modules/settings/settings-common';

import { RECORD_STATUSES, RULE_OPERATORS } from '../integrations.types';

const RUN_STATUSES = ['running', 'completed', 'partial', 'failed', 'cancelled'] as const;
const MAPPING_STATUSES = ['mapped', 'unmapped', 'suggested'] as const;

const toList = ({ value }: { value: unknown }) =>
	value === undefined || value === null || value === ''
		? undefined
		: (Array.isArray(value) ? value : [value])
				.flatMap((item) => String(item).split(','))
				.map((item) => item.trim())
				.filter(Boolean);
const toBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

class PageDto {
	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: 'page debe ser un número entero' })
	@Min(1, { message: 'page debe ser 1 o más' })
	page = 1;

	@ApiPropertyOptional({ default: 20, maximum: 100 })
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: 'limit debe ser un número entero' })
	@Min(1, { message: 'limit debe ser 1 o más' })
	@Max(100, { message: 'limit no puede superar 100' })
	limit = 20;
}

export class RunsQueryDto extends PageDto {
	@ApiPropertyOptional({ enum: RUN_STATUSES })
	@IsOptional()
	@IsIn(RUN_STATUSES, { message: 'Estado de corrida inválido' })
	status?: (typeof RUN_STATUSES)[number];

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(40)
	kind?: string;

	@ApiPropertyOptional({ enum: ['automatic', 'manual'] })
	@IsOptional()
	@IsIn(['automatic', 'manual'], { message: 'trigger debe ser automatic o manual' })
	trigger?: 'automatic' | 'manual';

	@ApiPropertyOptional({ example: '2026-10-01' })
	@IsOptional()
	@IsIsoDate('from debe ser una fecha YYYY-MM-DD')
	from?: string;

	@ApiPropertyOptional({ example: '2026-10-31' })
	@IsOptional()
	@IsIsoDate('to debe ser una fecha YYYY-MM-DD')
	to?: string;
}

export class RecordsQueryDto extends PageDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(40)
	object?: string;

	@ApiPropertyOptional({ type: [String], enum: RECORD_STATUSES, description: 'a,b o repetido' })
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@IsIn(RECORD_STATUSES, { each: true, message: 'Estado inválido' })
	status?: string[];

	@ApiPropertyOptional({ description: 'Nombre o id de la regla de exclusión' })
	@IsOptional()
	@IsString()
	@MaxLength(80)
	rule?: string;

	@ApiPropertyOptional({ description: 'Stripe: cuenta de origen' })
	@IsOptional()
	@IsUUID('all', { message: 'account_id debe ser un UUID' })
	account_id?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('from debe ser una fecha YYYY-MM-DD')
	from?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('to debe ser una fecha YYYY-MM-DD')
	to?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120, { message: 'La búsqueda admite hasta 120 caracteres' })
	search?: string;
}

export class SyncDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('date_from debe ser una fecha YYYY-MM-DD')
	date_from?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('date_to debe ser una fecha YYYY-MM-DD')
	date_to?: string;

	@ApiPropertyOptional({ description: 'Stripe: cuenta a sincronizar' })
	@IsOptional()
	@IsUUID('all', { message: 'connection_id debe ser un UUID' })
	connection_id?: string;
}

export class ImportRecordsDto {
	@ApiProperty()
	@IsString()
	@MaxLength(40)
	object!: string;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un registro' })
	@ArrayMaxSize(500, { message: 'Hasta 500 registros por vez' })
	@IsString({ each: true })
	ids?: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsBoolean()
	all?: boolean;

	@ApiPropertyOptional({ example: '2026-10' })
	@IsOptional()
	@Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period debe ser YYYY-MM' })
	period?: string;
}

export class DiscardRecordsDto {
	@ApiProperty()
	@IsString()
	@MaxLength(40)
	object!: string;

	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un registro' })
	@ArrayMaxSize(500, { message: 'Hasta 500 registros por vez' })
	@IsString({ each: true })
	ids!: string[];

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(200)
	reason?: string;
}

export class RestoreRecordsDto {
	@ApiProperty()
	@IsString()
	@MaxLength(40)
	object!: string;

	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un registro' })
	@ArrayMaxSize(500, { message: 'Hasta 500 registros por vez' })
	@IsString({ each: true })
	ids!: string[];
}

export class SetActiveDto {
	@ApiProperty()
	@IsBoolean({ message: 'active debe ser true o false' })
	active!: boolean;
}

export class ConfirmQueryDto {
	@ApiPropertyOptional()
	@IsOptional()
	@Transform(toBool)
	@IsBoolean({ message: 'confirm debe ser true o false' })
	confirm?: boolean;
}

export class ErpConnectionDto {
	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el nombre' })
	@MaxLength(120)
	name!: string;

	@ApiProperty()
	@IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] }, { message: 'La URL del ERP no es válida (con https://)' })
	url!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta la base de datos' })
	@MaxLength(200)
	database_name!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el usuario' })
	@MaxLength(200)
	username!: string;

	@ApiPropertyOptional({ description: 'Solo escritura' })
	@IsOptional()
	@IsString()
	@MinLength(1)
	@MaxLength(500)
	api_key?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	subscription_code?: string | null;
}

export class CrmConnectionDto {
	@ApiProperty({ enum: ['password', 'client_credentials'] })
	@IsIn(['password', 'client_credentials'], { message: 'auth_type debe ser password o client_credentials' })
	auth_type!: 'password' | 'client_credentials';

	@ApiPropertyOptional()
	@IsOptional()
	@IsUrl({}, { message: 'La URL de inicio de sesión no es válida' })
	login_url?: string;

	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el client_id' })
	@MaxLength(500)
	client_id!: string;

	@ApiPropertyOptional({ description: 'Solo escritura' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	client_secret?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(200)
	username?: string;

	@ApiPropertyOptional({ description: 'Solo escritura' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	password?: string;

	@ApiPropertyOptional({ description: 'Solo escritura' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	security_token?: string;
}

export class StripeConnectionDto {
	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el nombre' })
	@MaxLength(120)
	name!: string;

	@ApiProperty({ enum: ['test', 'live'] })
	@IsIn(['test', 'live'], { message: 'mode debe ser test o live' })
	mode!: 'test' | 'live';

	@ApiPropertyOptional({ description: 'Solo escritura' })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	secret_key?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(500)
	publishable_key?: string | null;
}

export class DatosConnectionDto {
	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el nombre' })
	@MaxLength(120)
	name!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el proyecto' })
	@MaxLength(200)
	project_id!: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(200)
	dataset_id?: string | null;

	@ApiPropertyOptional({ description: 'JSON de la cuenta de servicio (solo escritura)' })
	@IsOptional()
	@IsString()
	@MaxLength(20_000)
	credentials?: string;
}

export class MappingQueryDto {
	@ApiPropertyOptional({ enum: MAPPING_STATUSES })
	@IsOptional()
	@IsIn(MAPPING_STATUSES, { message: 'Estado de mapeo inválido' })
	status?: (typeof MAPPING_STATUSES)[number];

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	search?: string;
}

export class MappingOptionsQueryDto {
	@ApiPropertyOptional({ enum: ['sapira', 'external'] })
	@IsOptional()
	@IsIn(['sapira', 'external'], { message: 'side debe ser sapira o external' })
	side?: 'sapira' | 'external';

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(120)
	search?: string;
}

export class MappingItemDto {
	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	sapira_id!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	external_id!: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsObject()
	meta?: Record<string, unknown>;
}

export class PutMappingDto {
	@ApiProperty({ type: [MappingItemDto] })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos un mapeo' })
	@ArrayMaxSize(200, { message: 'Hasta 200 mapeos por vez' })
	@ValidateNested({ each: true })
	@Type(() => MappingItemDto)
	items!: MappingItemDto[];
}

export class DeleteMappingQueryDto extends ConfirmQueryDto {
	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	sapira_id!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	external_id!: string;
}

export class AcceptSuggestionsDto {
	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(500)
	@IsString({ each: true })
	keys?: string[];
}

export class TaxesQueryDto {
	@ApiPropertyOptional({ description: 'Compañía de Sapira (mapeada)' })
	@IsOptional()
	@IsUUID('all', { message: 'company_id debe ser un UUID' })
	company_id?: string;

	@ApiPropertyOptional({ description: 'Compañía del ERP' })
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: 'erp_company_id debe ser un número' })
	@Min(1)
	erp_company_id?: number;
}

export class SettingsDto {
	@ApiProperty({ description: 'Reglas del tipo (contrato §6.1)' })
	@IsObject({ message: 'settings debe ser un objeto' })
	settings!: Record<string, unknown>;
}

export class RuleConditionDto {
	@ApiProperty({ example: 'raw_data.Owner.Name' })
	@IsString()
	@MinLength(1)
	@MaxLength(200)
	field!: string;

	@ApiProperty({ enum: RULE_OPERATORS })
	@IsIn(RULE_OPERATORS, { message: 'Operador no válido' })
	operator!: (typeof RULE_OPERATORS)[number];

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(200)
	value?: string | null;
}

export class RuleDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID('all')
	id?: string;

	@ApiProperty()
	@IsString()
	@MinLength(1, { message: 'Falta el nombre de la regla' })
	@MaxLength(80)
	name!: string;

	@ApiProperty()
	@IsString()
	@MaxLength(40)
	object!: string;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	enabled?: boolean;

	@ApiProperty({ type: [RuleConditionDto] })
	@IsArray()
	@ArrayMinSize(1, { message: 'La regla necesita al menos una condición' })
	@ArrayMaxSize(10)
	@ValidateNested({ each: true })
	@Type(() => RuleConditionDto)
	conditions!: RuleConditionDto[];
}

export class RulesDto {
	@ApiProperty({ type: [RuleDto] })
	@IsArray()
	@ArrayMaxSize(50, { message: 'Hasta 50 reglas' })
	@ValidateNested({ each: true })
	@Type(() => RuleDto)
	rules!: RuleDto[];
}

export class RuleFieldsQueryDto {
	@ApiProperty()
	@IsString()
	@MaxLength(40)
	object!: string;
}

export class CrmFetchDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('date_from debe ser una fecha YYYY-MM-DD')
	date_from?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsIsoDate('date_to debe ser una fecha YYYY-MM-DD')
	date_to?: string;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(200, { message: 'Hasta 200 oportunidades por vez' })
	@Matches(/^[a-zA-Z0-9]{15,18}$/, { each: true, message: 'Id de oportunidad inválido' })
	opportunity_ids?: string[];
}

export class CrmImportDto {
	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1, { message: 'Indica al menos una oportunidad' })
	@ArrayMaxSize(200, { message: 'Hasta 200 oportunidades por vez' })
	@Matches(/^[a-zA-Z0-9]{15,18}$/, { each: true, message: 'Id de oportunidad inválido' })
	opportunity_ids!: string[];

	@ApiPropertyOptional({ enum: ['full', 'review'] })
	@IsOptional()
	@IsIn(['full', 'review'], { message: 'mode debe ser full o review' })
	mode?: 'full' | 'review';
}

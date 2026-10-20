import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsEmail,
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
} from 'class-validator';

import { KAME_ENVIRONMENTS, type KameEnvironment } from '../kame.types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Credencial de una compañía en un ambiente. El secret es solo de escritura: vacío conserva el guardado. */
export class KameConnectionDto {
	@ApiProperty({ description: 'Client ID de la API de Kame' })
	@Transform(trim)
	@IsString()
	@MinLength(1, { message: 'Escribe el client ID' })
	@MaxLength(200)
	client_id!: string;

	@ApiPropertyOptional({ description: 'Client secret (solo escritura; vacío conserva el guardado)' })
	@IsOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(500)
	client_secret?: string;

	@ApiProperty({ description: 'Correo de un usuario de la empresa en Kame (va en cada envío)' })
	@Transform(trim)
	@IsEmail({}, { message: 'Escribe un correo válido' })
	user_email!: string;

	@ApiProperty({ description: 'RUT de la empresa en Kame', example: '10.491.356-3' })
	@Transform(trim)
	@IsString()
	@MinLength(3, { message: 'Escribe el RUT de la empresa en Kame' })
	@MaxLength(20)
	kame_company_rut!: string;

	@ApiPropertyOptional({ description: 'Unidad de negocio de Kame (centro de costo)' })
	@IsOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	business_unit?: string | null;

	@ApiPropertyOptional({ description: 'Sucursal de Kame; vacía = casa matriz' })
	@IsOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	branch?: string | null;
}

/** Ruta `companies/:companyId/...`: todos los parámetros van en un DTO (el ValidationPipe rechaza los que no declara). */
export class KameCompanyParamDto {
	@IsUUID('4', { message: 'companyId debe ser un UUID' })
	companyId!: string;
}

export class KameEnvironmentParamDto extends KameCompanyParamDto {
	@IsIn(KAME_ENVIRONMENTS, { message: 'El ambiente es pruebas o produccion' })
	environment!: KameEnvironment;
}

export class KameSettingsDto {
	@ApiPropertyOptional({ description: 'Conexión de la compañía activa' })
	@IsOptional()
	@IsBoolean()
	enabled?: boolean;

	@ApiPropertyOptional({ description: 'Registrar en Kame las facturas emitidas en Sapira' })
	@IsOptional()
	@IsBoolean()
	send_invoices?: boolean;

	@ApiPropertyOptional({ description: 'Enviar a Kame los asientos de devengo de los meses cerrados' })
	@IsOptional()
	@IsBoolean()
	send_journal?: boolean;

	@ApiPropertyOptional({ description: 'Simulación: arma el envío sin llamar a Kame' })
	@IsOptional()
	@IsBoolean()
	dry_run?: boolean;

	@ApiPropertyOptional({ description: 'Facturas emitidas desde (YYYY-MM-DD)' })
	@IsOptional()
	@Matches(DATE, { message: 'invoices_from debe ser YYYY-MM-DD' })
	invoices_from?: string | null;

	@ApiPropertyOptional({ description: 'Primer mes de asientos (YYYY-MM)' })
	@IsOptional()
	@Matches(MONTH, { message: 'journal_from debe ser YYYY-MM' })
	journal_from?: string | null;
}

export class KameSwitchEnvironmentDto {
	@ApiProperty({ enum: KAME_ENVIRONMENTS })
	@IsIn(KAME_ENVIRONMENTS, { message: 'El ambiente es pruebas o produccion' })
	environment!: KameEnvironment;

	@ApiPropertyOptional({ description: 'Al pasar a producción: facturas emitidas desde (YYYY-MM-DD); por defecto, hoy' })
	@IsOptional()
	@Matches(DATE, { message: 'invoices_from debe ser YYYY-MM-DD' })
	invoices_from?: string;

	@ApiPropertyOptional({ description: 'Al pasar a producción: primer mes de asientos (YYYY-MM); por defecto, el último cerrado' })
	@IsOptional()
	@Matches(MONTH, { message: 'journal_from debe ser YYYY-MM' })
	journal_from?: string;
}

export class KameAutoDto {
	@ApiProperty({ description: 'Envío automático a Kame del holding' })
	@IsBoolean({ message: 'enabled debe ser true o false' })
	enabled!: boolean;
}

export class KameSendNowDto {
	@ApiPropertyOptional({ description: 'Solo esta compañía' })
	@IsOptional()
	@IsUUID('4', { message: 'company_id debe ser un UUID' })
	company_id?: string;
}

export class KameRetryDto {
	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(200)
	@IsUUID('4', { each: true, message: 'Cada id debe ser un UUID' })
	ids!: string[];
}

export class KameExportsQueryDto {
	@IsOptional()
	@IsUUID('4')
	company_id?: string;

	@IsOptional()
	@IsIn(['invoice', 'journal'])
	object?: string;

	@IsOptional()
	@Matches(/^(pending|sending|sent|error|simulated|skipped)(,(pending|sending|sent|error|simulated|skipped))*$/, { message: 'status no válido' })
	status?: string;

	@IsOptional()
	@IsIn(KAME_ENVIRONMENTS)
	environment?: string;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

export class KamePeriodParamDto extends KameCompanyParamDto {
	@Matches(MONTH, { message: 'El mes va como YYYY-MM' })
	period!: string;
}

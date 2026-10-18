import { Transform } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayNotEmpty,
	IsArray,
	IsDateString,
	IsEnum,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
} from 'class-validator';

export class UpdateSiiConfigurationDto {
	@IsEnum(['certificacion', 'produccion'])
	environment!: 'certificacion' | 'produccion';
	@IsOptional() @IsString() business_activity?: string;
	@IsArray() @ArrayNotEmpty() @IsString({ each: true }) activity_codes!: string[];
	@IsOptional() @IsString() commune?: string;
	@IsOptional() @IsString() city?: string;
	@IsOptional() @IsString() region?: string;
	@IsOptional() @IsInt() resolution_number?: number;
	@IsOptional() @IsDateString() resolution_date?: string;
	@IsArray() @ArrayNotEmpty() @IsInt({ each: true }) enabled_document_types!: number[];
}

export class CompanyQueryDto {
	@IsOptional() @IsUUID() holding_id?: string;
}

export class CreateCafDto {
	@IsInt() @Min(1) @Max(999) @Transform(({ value }) => Number(value)) document_type!: number;
}

export class ReserveFolioDto {
	@IsUUID() company_id!: string;
	@IsInt() document_type!: number;
	@IsString() idempotency_key!: string;
}

/**
 * Activar la facturación electrónica o, con la compañía ya activa, editar su emisor: la provisión en api-factura es
 * idempotente y sin `environment` se conserva el guardado. Largos del SII (`DTE_v10.xsd`): `GiroEmis` 80,
 * `CmnaOrigen` y `CiudadOrigen` 20, `DirOrigen` 70.
 */
export class IntegrateFacturaDto {
	@IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) business_activity?: string;
	@IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) commune?: string;
	@IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) city?: string;
	/** Dirección del emisor para el SII (`DirOrigen`, hasta 70). Sin ella se usa la dirección legal de la compañía. */
	@IsOptional() @IsString() @IsNotEmpty() @MaxLength(70) address?: string;
	/** Códigos de actividad económica del emisor (`Acteco`): de 1 a 4, enteros positivos de hasta 6 dígitos. */
	@IsOptional()
	@IsArray()
	@ArrayNotEmpty()
	@ArrayMaxSize(4)
	@Matches(/^[1-9]\d{0,5}$/, { each: true, message: 'Cada código de actividad económica tiene hasta 6 dígitos' })
	activity_codes?: string[];
	@IsOptional() @IsString() region?: string;
	@IsOptional() @IsEnum(['certificacion', 'produccion']) environment?: 'certificacion' | 'produccion';
}

import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

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

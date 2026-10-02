import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { emptyToNull, trim } from './holding.dto';

export const MASTER_DATA_CATEGORIES = ['payment_terms', 'item_types', 'units_of_measure'] as const;
export type MasterDataCategory = (typeof MASTER_DATA_CATEGORIES)[number];

export class CreateSellerDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre es obligatorio' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	name!: string;

	@ApiProperty()
	@Transform(trim)
	@IsEmail({}, { message: 'El correo no es válido' })
	email!: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El teléfono debe ser texto' })
	@MaxLength(50, { message: 'El teléfono no puede superar 50 caracteres' })
	@IsOptional()
	phone?: string | null;
}

export class UpdateSellerDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsEmail({}, { message: 'El correo no es válido' })
	@IsOptional()
	email?: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El teléfono debe ser texto' })
	@MaxLength(50, { message: 'El teléfono no puede superar 50 caracteres' })
	@IsOptional()
	phone?: string | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_active debe ser verdadero o falso' })
	@IsOptional()
	is_active?: boolean;
}

export class CreateNamedDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre es obligatorio' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	name!: string;
}

export class UpdateNamedDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_active debe ser verdadero o falso' })
	@IsOptional()
	is_active?: boolean;
}

export class CreateMasterDataDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El valor debe ser texto' })
	@MinLength(1, { message: 'El valor es obligatorio' })
	@MaxLength(100, { message: 'El valor no puede superar 100 caracteres' })
	value!: string;
}

export class UpdateMasterDataDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El valor debe ser texto' })
	@MinLength(1, { message: 'El valor no puede quedar vacío' })
	@MaxLength(100, { message: 'El valor no puede superar 100 caracteres' })
	@IsOptional()
	value?: string;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_active debe ser verdadero o falso' })
	@IsOptional()
	is_active?: boolean;
}

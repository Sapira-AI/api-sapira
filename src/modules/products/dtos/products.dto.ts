import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export class ProductsQueryDto {
	@ApiPropertyOptional({ enum: ['active', 'archived', 'all'], default: 'all' })
	@IsIn(['active', 'archived', 'all'], { message: 'status debe ser active, archived o all' })
	@IsOptional()
	status?: ProductStatus | 'all';

	@ApiPropertyOptional({ description: 'Busca en código y nombre' })
	@Transform(trim)
	@IsString()
	@MaxLength(100)
	@IsOptional()
	search?: string;
}

export class CreateProductDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El código debe ser texto' })
	@MinLength(1, { message: 'El código es obligatorio' })
	@MaxLength(50, { message: 'El código no puede superar 50 caracteres' })
	product_code!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre es obligatorio' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	name!: string;

	@ApiPropertyOptional({ default: true })
	@IsBoolean({ message: 'is_recurring debe ser verdadero o falso' })
	@IsOptional()
	is_recurring?: boolean;
}

export class UpdateProductDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El código debe ser texto' })
	@MinLength(1, { message: 'El código no puede quedar vacío' })
	@MaxLength(50, { message: 'El código no puede superar 50 caracteres' })
	@IsOptional()
	product_code?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_recurring debe ser verdadero o falso' })
	@IsOptional()
	is_recurring?: boolean;
}

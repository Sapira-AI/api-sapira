import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export class ProductsQueryDto {
	@ApiPropertyOptional({ enum: ['active', 'archived', 'all'], default: 'all' })
	@IsIn(['active', 'archived', 'all'], { message: 'El estado debe ser activo, archivado o todos' })
	@IsOptional()
	status?: ProductStatus | 'all';

	@ApiPropertyOptional({ description: 'Busca en código y nombre' })
	@Transform(trim)
	@IsString({ message: 'La búsqueda debe ser texto' })
	@MaxLength(100, { message: 'La búsqueda no puede superar 100 caracteres' })
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
	@IsBoolean({ message: 'Recurrente debe ser sí o no' })
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
	@IsBoolean({ message: 'Recurrente debe ser sí o no' })
	@IsOptional()
	is_recurring?: boolean;
}

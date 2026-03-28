import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class StripeProductDTO {
	@ApiProperty({ description: 'ID del producto en Stripe' })
	@IsString()
	id!: string;

	@ApiProperty({ description: 'Nombre del producto' })
	@IsString()
	name!: string;

	@ApiProperty({ description: 'Descripción del producto', required: false })
	@IsOptional()
	@IsString()
	description?: string;

	@ApiProperty({ description: 'Indica si el producto está activo' })
	@IsBoolean()
	active!: boolean;

	@ApiProperty({ description: 'ID del precio por defecto', required: false })
	@IsOptional()
	@IsString()
	default_price?: string;

	@ApiProperty({ description: 'Metadatos del producto', required: false })
	@IsOptional()
	@IsObject()
	metadata?: Record<string, string>;
}

export class SapiraProductDTO {
	@ApiProperty({ description: 'ID del producto en Sapira' })
	@IsString()
	id!: string;

	@ApiProperty({ description: 'Código del producto', required: false })
	@IsOptional()
	@IsString()
	product_code?: string;

	@ApiProperty({ description: 'Nombre del producto', required: false })
	@IsOptional()
	@IsString()
	name?: string;

	@ApiProperty({ description: 'Precio por defecto', required: false })
	@IsOptional()
	default_price?: number;

	@ApiProperty({ description: 'IDs de productos en Stripe mapeados a este producto', required: false, type: [String] })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	stripe_product_mappings?: string[];
}

export class GetProductsResponseDTO {
	@ApiProperty({ description: 'Lista de productos de Stripe', type: [StripeProductDTO] })
	@IsArray()
	stripe_products!: StripeProductDTO[];

	@ApiProperty({ description: 'Lista de productos de Sapira', type: [SapiraProductDTO] })
	@IsArray()
	sapira_products!: SapiraProductDTO[];
}

export class ProductMappingItemDTO {
	@ApiProperty({ description: 'ID del producto en Sapira' })
	@IsString()
	sapira_product_id!: string;

	@ApiProperty({ description: 'ID del producto en Stripe' })
	@IsString()
	stripe_product_id!: string;
}

export class SaveProductMappingDTO {
	@ApiProperty({ description: 'Array de mapeos de productos', type: [ProductMappingItemDTO] })
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => ProductMappingItemDTO)
	mappings!: ProductMappingItemDTO[];
}

export class SaveProductMappingResponseDTO {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success!: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message!: string;

	@ApiProperty({ description: 'Cantidad de productos actualizados' })
	updated_count!: number;
}

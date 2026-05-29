import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class SalesforceProductMappingDto {
	@ApiProperty({ description: 'ID del producto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_product_id: string;

	@ApiProperty({ description: 'Nombre del producto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_product_name: string;

	@ApiPropertyOptional({ description: 'Código del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_product_code?: string;

	@ApiPropertyOptional({ description: 'Familia del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_family?: string;

	@ApiProperty({ description: 'ID del producto en Sapira' })
	@IsUUID()
	@IsNotEmpty()
	sapira_product_id: string;

	@ApiProperty({ description: 'Nombre del producto en Sapira' })
	@IsString()
	@IsNotEmpty()
	sapira_product_name: string;

	@ApiPropertyOptional({ description: 'Si el mapeo está activo', default: true })
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class CreateProductMappingDto {
	@ApiProperty({ description: 'ID del producto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_product_id: string;

	@ApiProperty({ description: 'Nombre del producto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_product_name: string;

	@ApiPropertyOptional({ description: 'Código del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_product_code?: string;

	@ApiPropertyOptional({ description: 'Familia del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_family?: string;

	@ApiProperty({ description: 'ID del producto en Sapira' })
	@IsUUID()
	@IsNotEmpty()
	sapira_product_id: string;

	@ApiProperty({ description: 'Nombre del producto en Sapira' })
	@IsString()
	@IsNotEmpty()
	sapira_product_name: string;
}

export class UpdateProductMappingDto {
	@ApiPropertyOptional({ description: 'Nombre del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_product_name?: string;

	@ApiPropertyOptional({ description: 'Código del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_product_code?: string;

	@ApiPropertyOptional({ description: 'Familia del producto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_family?: string;

	@ApiPropertyOptional({ description: 'ID del producto en Sapira' })
	@IsUUID()
	@IsOptional()
	sapira_product_id?: string;

	@ApiPropertyOptional({ description: 'Nombre del producto en Sapira' })
	@IsString()
	@IsOptional()
	sapira_product_name?: string;

	@ApiPropertyOptional({ description: 'Si el mapeo está activo' })
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class SalesforceQuoteTypeMappingDto {
	@ApiProperty({ description: 'Tipo de oportunidad en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_type: string;

	@ApiProperty({ description: 'Tipo de cotización en Sapira' })
	@IsString()
	@IsNotEmpty()
	sapira_quote_type: string;

	@ApiPropertyOptional({ description: 'Si el mapeo está activo', default: true })
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class CreateQuoteTypeMappingDto {
	@ApiProperty({ description: 'Tipo de oportunidad en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_type: string;

	@ApiProperty({ description: 'Tipo de cotización en Sapira' })
	@IsString()
	@IsNotEmpty()
	sapira_quote_type: string;
}

export class UpdateQuoteTypeMappingDto {
	@ApiPropertyOptional({ description: 'Tipo de oportunidad en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_type?: string;

	@ApiPropertyOptional({ description: 'Tipo de cotización en Sapira' })
	@IsString()
	@IsOptional()
	sapira_quote_type?: string;

	@ApiPropertyOptional({ description: 'Si el mapeo está activo' })
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class SalesforceObjectMappingDto {
	@ApiProperty({ description: 'ID del objeto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_object_id: string;

	@ApiProperty({ description: 'Tipo de objeto en Salesforce (Account, Contact, etc.)' })
	@IsString()
	@IsNotEmpty()
	salesforce_object_type: string;

	@ApiProperty({ description: 'Nombre de la tabla en Sapira (clients, etc.)' })
	@IsString()
	@IsNotEmpty()
	sapira_table_name: string;

	@ApiProperty({ description: 'ID del registro en Sapira' })
	@IsUUID()
	@IsNotEmpty()
	sapira_record_id: string;

	@ApiPropertyOptional({ description: 'Metadata adicional del mapeo' })
	@IsOptional()
	metadata?: any;
}

export class CreateObjectMappingDto {
	@ApiProperty({ description: 'ID del objeto en Salesforce' })
	@IsString()
	@IsNotEmpty()
	salesforce_object_id: string;

	@ApiProperty({ description: 'Tipo de objeto en Salesforce (Account, Contact, etc.)' })
	@IsString()
	@IsNotEmpty()
	salesforce_object_type: string;

	@ApiProperty({ description: 'Nombre de la tabla en Sapira (clients, etc.)' })
	@IsString()
	@IsNotEmpty()
	sapira_table_name: string;

	@ApiProperty({ description: 'ID del registro en Sapira' })
	@IsUUID()
	@IsNotEmpty()
	sapira_record_id: string;

	@ApiPropertyOptional({ description: 'Metadata adicional del mapeo' })
	@IsOptional()
	metadata?: any;
}

export class UpdateObjectMappingDto {
	@ApiPropertyOptional({ description: 'Tipo de objeto en Salesforce' })
	@IsString()
	@IsOptional()
	salesforce_object_type?: string;

	@ApiPropertyOptional({ description: 'Nombre de la tabla en Sapira' })
	@IsString()
	@IsOptional()
	sapira_table_name?: string;

	@ApiPropertyOptional({ description: 'ID del registro en Sapira' })
	@IsUUID()
	@IsOptional()
	sapira_record_id?: string;

	@ApiPropertyOptional({ description: 'Metadata adicional del mapeo' })
	@IsOptional()
	metadata?: any;
}

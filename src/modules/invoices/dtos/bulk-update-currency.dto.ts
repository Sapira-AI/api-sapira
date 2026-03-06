import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class BulkUpdateCurrencyDto {
	@ApiProperty({
		description: 'Array de IDs de facturas a actualizar',
		example: ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
		type: [String],
	})
	@IsArray()
	@IsNotEmpty()
	invoiceIds: string[];

	@ApiProperty({
		description: 'Nueva moneda de facturación (código ISO de 3 letras)',
		example: 'EUR',
		minLength: 3,
		maxLength: 3,
	})
	@IsString()
	@IsNotEmpty()
	@Length(3, 3)
	newCurrency: string;

	@ApiPropertyOptional({
		description: 'Modo simulación: si es true, no aplica cambios a la BD',
		example: false,
		default: false,
	})
	@IsBoolean()
	@IsOptional()
	dryRun?: boolean;
}

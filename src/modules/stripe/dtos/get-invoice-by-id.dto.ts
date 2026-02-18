import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GetInvoiceByIdDto {
	@ApiProperty({
		description: 'ID de la factura en Stripe',
		example: 'in_123456789',
	})
	@IsString()
	@IsNotEmpty()
	invoice_id: string;
}

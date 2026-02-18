import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GetCustomerByIdDto {
	@ApiProperty({
		description: 'ID del cliente en Stripe',
		example: 'cus_123456789',
	})
	@IsString()
	@IsNotEmpty()
	customer_id: string;
}

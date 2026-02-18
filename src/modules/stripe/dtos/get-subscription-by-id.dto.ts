import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GetSubscriptionByIdDto {
	@ApiProperty({
		description: 'ID de la suscripción en Stripe',
		example: 'sub_123456789',
	})
	@IsString()
	@IsNotEmpty()
	subscription_id: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class SyncStripeCustomersRequestDto {
	@ApiProperty({
		description: 'ID del holding para asociar los registros de Stripe',
		example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
		required: true,
	})
	@IsUUID()
	@IsNotEmpty()
	holdingId: string;
}

export class SyncStripeCustomersResponseDto {
	@ApiProperty({
		description: 'Número total de registros procesados desde BigQuery',
		example: 150,
	})
	totalProcessed: number;

	@ApiProperty({
		description: 'Número de registros nuevos insertados',
		example: 50,
	})
	inserted: number;

	@ApiProperty({
		description: 'Número de registros actualizados',
		example: 100,
	})
	updated: number;

	@ApiProperty({
		description: 'Mensaje de resultado',
		example: 'Sincronización completada exitosamente',
	})
	message: string;
}

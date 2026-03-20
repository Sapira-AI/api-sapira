import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class SyncRequestDto {
	@ApiProperty({
		description: 'Número de registros a procesar en cada lote',
		example: 100,
		required: false,
		default: 100,
	})
	@IsOptional()
	@IsNumber()
	@Min(1)
	batchSize?: number = 100;
}

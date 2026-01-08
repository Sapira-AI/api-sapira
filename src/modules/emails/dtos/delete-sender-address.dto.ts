import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class DeleteSenderAddressDto {
	@ApiProperty({
		description: 'ID del remitente a eliminar',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	sender_id: string;
}

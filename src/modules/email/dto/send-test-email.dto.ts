import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsUUID } from 'class-validator';

export class SendTestEmailDto {
	@ApiProperty({
		description: 'Email de prueba al que se enviará el correo',
		example: 'test@example.com',
	})
	@IsEmail()
	@IsNotEmpty()
	test_email: string;

	@ApiProperty({
		description: 'ID del holding',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;
}

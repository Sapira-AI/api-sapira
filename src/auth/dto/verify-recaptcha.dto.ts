import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyRecaptchaDto {
	@ApiProperty({ description: 'Token generado por reCAPTCHA Enterprise en el navegador' })
	@IsString()
	@IsNotEmpty()
	token: string;

	@ApiProperty({ description: 'Acción esperada (LOGIN o public_lead)', example: 'LOGIN' })
	@IsString()
	@IsNotEmpty()
	action: string;
}

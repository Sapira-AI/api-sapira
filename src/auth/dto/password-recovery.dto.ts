import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class PasswordRecoveryDto {
	@ApiProperty({ example: 'ana@cliente.com' })
	@Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
	@IsEmail({}, { message: 'El correo no es válido' })
	@MaxLength(254, { message: 'El correo no puede superar 254 caracteres' })
	email!: string;
}

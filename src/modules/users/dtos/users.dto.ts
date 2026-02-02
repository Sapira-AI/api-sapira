import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsUUID } from 'class-validator';

export class UserResponseDto {
	@ApiProperty({
		description: 'UUID del usuario',
		example: '1dedf14a-ba51-4b93-9c74-7f869e17d4dc',
	})
	id: string;

	@ApiPropertyOptional({
		description: 'Nombre del usuario',
		example: 'León Montero',
	})
	name?: string;

	@ApiProperty({
		description: 'Email del usuario',
		example: 'leon.montero@blixter.cl',
	})
	email: string;

	@ApiPropertyOptional({
		description: 'UUID del rol del usuario',
		example: '8629d9cd-9384-4088-b81e-1ed43c3f4737',
	})
	role_id?: string;

	@ApiPropertyOptional({
		description: 'Estado del usuario',
		example: 'Activo',
	})
	status?: string;

	@ApiPropertyOptional({
		description: 'Último acceso del usuario',
		example: '2025-11-21T08:10:43.574324Z',
	})
	last_access?: Date;

	@ApiPropertyOptional({
		description: 'Proveedor de autenticación',
		example: 'google',
	})
	auth_provider?: string;

	@ApiPropertyOptional({
		description: 'UUID de autenticación (auth.users.id)',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
	})
	auth_id?: string;

	@ApiProperty({
		description: 'Fecha de creación del usuario',
		example: '2025-06-18T20:13:31.271797Z',
	})
	created_at: Date;

	@ApiPropertyOptional({
		description: 'Indica si el usuario es super admin',
		example: false,
	})
	is_super_admin?: boolean;
}

export class GetUserByAuthIdQueryDto {
	@ApiProperty({
		description: 'UUID de autenticación del usuario',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
	})
	@IsUUID()
	auth_id: string;
}

export class GetUserByEmailQueryDto {
	@ApiProperty({
		description: 'Email del usuario',
		example: 'leon.montero@blixter.cl',
	})
	@IsEmail()
	email: string;
}

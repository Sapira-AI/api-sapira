import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UserHoldingResponseDto {
	@ApiProperty({
		description: 'UUID del holding',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
	})
	id: string;

	@ApiProperty({
		description: 'Nombre del holding',
		example: 'UPLANNER',
	})
	name: string;

	@ApiPropertyOptional({
		description: 'Sitio web del holding',
		example: 'https://u-planner.com',
	})
	website?: string;

	@ApiPropertyOptional({
		description: 'Teléfono del holding',
		example: '+56 2 1234 5678',
	})
	phone?: string;

	@ApiPropertyOptional({
		description: 'Email del holding',
		example: 'contact@u-planner.com',
	})
	email?: string;

	@ApiPropertyOptional({
		description: 'URL del logo del holding',
		example: 'https://storage.example.com/logos/uplanner.png',
	})
	logo_url?: string;

	@ApiProperty({
		description: 'Fecha de creación del holding',
		example: '2024-01-15T10:30:00Z',
	})
	created_at: Date;

	@ApiPropertyOptional({
		description: 'Indica si el cambio manual de estado está habilitado',
		example: false,
	})
	manual_status_change_enabled?: boolean;

	@ApiProperty({
		description: 'Indica si este es el holding seleccionado actualmente por el usuario',
		example: true,
	})
	selected: boolean;

	@ApiProperty({
		description: 'Indica si el acceso del usuario a este holding está activo',
		example: true,
	})
	is_active: boolean;
}

export class GetUserHoldingsQueryDto {
	@ApiPropertyOptional({
		description: 'UUID del usuario (opcional, si no se provee usa el usuario autenticado)',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
	})
	@IsOptional()
	@IsUUID()
	user_id?: string;
}

export class UpdateSelectedHoldingDto {
	@ApiProperty({
		description: 'UUID del holding a seleccionar',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
	})
	@IsUUID()
	holding_id: string;
}

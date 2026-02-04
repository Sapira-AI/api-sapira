import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ClientResponseDto {
	@ApiProperty({
		description: 'ID único del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	id!: string;

	@ApiPropertyOptional({
		description: 'ID del holding al que pertenece el cliente',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
	})
	holding_id?: string;

	@ApiPropertyOptional({
		description: 'Nombre comercial del cliente',
		example: 'Acme Corporation',
	})
	name_commercial?: string;

	@ApiPropertyOptional({
		description: 'Segmento del cliente',
		example: 'Enterprise',
	})
	segment?: string;

	@ApiPropertyOptional({
		description: 'Industria del cliente',
		example: 'Tecnología',
	})
	industry?: string;

	@ApiPropertyOptional({
		description: 'Mercado del cliente',
		example: 'Latam',
	})
	market?: string;

	@ApiPropertyOptional({
		description: 'Estado del cliente',
		example: 'Activo',
	})
	status?: string;

	@ApiPropertyOptional({
		description: 'Indica si el portal está habilitado para el cliente',
		example: false,
	})
	portal_enabled?: boolean;

	@ApiPropertyOptional({
		description: 'Fecha desde que es cliente',
		example: '2024-01-01',
	})
	client_since?: Date;

	@ApiPropertyOptional({
		description: 'Notas adicionales sobre el cliente',
		example: 'Cliente VIP',
	})
	notes?: string;

	@ApiPropertyOptional({
		description: 'Fecha de creación',
		example: '2024-01-01T00:00:00.000Z',
	})
	created_at?: Date;

	@ApiPropertyOptional({
		description: 'País del cliente',
		example: 'Chile',
	})
	country?: string;

	@ApiPropertyOptional({
		description: 'Número de cliente',
		example: 'CLI-001',
	})
	client_number?: string;

	@ApiPropertyOptional({
		description: 'Campos personalizados en formato JSON',
		example: { custom_field_1: 'value1' },
	})
	custom_fields?: Record<string, any>;

	@ApiPropertyOptional({
		description: 'ID de cuenta de Salesforce',
		example: '001RO00000OGBsvYAH',
	})
	salesforce_account_id?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';

export class CreateClientAgentConfigDto {
	@ApiProperty({
		description: 'ID del holding',
		example: 'uuid',
	})
	@IsUUID()
	holding_id!: string;

	@ApiProperty({
		description: 'ID del cliente',
		example: 'uuid',
	})
	@IsUUID()
	client_id!: string;

	@ApiProperty({
		description: 'Tipo de agente',
		enum: ['proforma', 'collections'],
		example: 'proforma',
	})
	@IsEnum(['proforma', 'collections'])
	agent_type!: 'proforma' | 'collections';

	@ApiProperty({
		description: 'Indica si el agente está habilitado para este cliente',
		example: true,
	})
	@IsBoolean()
	is_enabled!: boolean;

	@ApiProperty({
		description: 'Configuración JSON personalizada',
		example: {
			days_before_issue: 10,
			email_sender_address_id: 'uuid',
		},
	})
	@IsObject()
	config_json!: Record<string, any>;
}

export class UpdateClientAgentConfigDto {
	@ApiProperty({
		description: 'Indica si el agente está habilitado para este cliente',
		example: true,
		required: false,
	})
	@IsOptional()
	@IsBoolean()
	is_enabled?: boolean;

	@ApiProperty({
		description: 'Configuración JSON personalizada',
		example: {
			days_before_issue: 15,
			email_sender_address_id: 'uuid',
		},
		required: false,
	})
	@IsOptional()
	@IsObject()
	config_json?: Record<string, any>;
}

export class CreateHoldingAgentConfigDto {
	@ApiProperty({
		description: 'ID del holding',
		example: 'uuid',
	})
	@IsUUID()
	holding_id!: string;

	@ApiProperty({
		description: 'Tipo de agente',
		enum: ['proforma', 'collections'],
		example: 'proforma',
	})
	@IsEnum(['proforma', 'collections'])
	agent_type!: 'proforma' | 'collections';

	@ApiProperty({
		description: 'Indica si el agente está habilitado globalmente',
		example: true,
	})
	@IsBoolean()
	is_enabled!: boolean;

	@ApiProperty({
		description: 'Configuración JSON global',
		example: {
			reminder_levels: [
				{
					level: 1,
					days_overdue: 30,
					frequency_hours: 168,
				},
			],
		},
	})
	@IsObject()
	config_json!: Record<string, any>;
}

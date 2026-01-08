import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateAgentConfigDto {
	@ApiProperty({
		description: 'Expresión cron para programar la ejecución automática',
		example: '0 9 * * *',
		required: false,
	})
	@IsOptional()
	@IsString()
	schedule?: string;

	@ApiProperty({
		description: 'Indica si el agente se ejecuta automáticamente según el schedule',
		example: true,
		required: false,
	})
	@IsOptional()
	@IsBoolean()
	auto_execute?: boolean;

	@ApiProperty({
		description: 'Indica si los mensajes requieren aprobación manual antes de enviarse',
		example: true,
		required: false,
	})
	@IsOptional()
	@IsBoolean()
	require_approval?: boolean;
}

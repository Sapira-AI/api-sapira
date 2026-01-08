import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class RunAgentDto {
	@ApiProperty({
		description: 'Modo de ejecución del agente',
		enum: ['preview', 'execute'],
		example: 'preview',
	})
	@IsEnum(['preview', 'execute'])
	mode!: 'preview' | 'execute';

	@ApiProperty({
		description: 'ID del holding (opcional, se obtiene del token)',
		example: 'uuid',
		required: false,
	})
	@IsOptional()
	@IsUUID()
	holding_id?: string;
}

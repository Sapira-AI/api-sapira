import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';

class MessageDto {
	@ApiProperty({ description: 'Rol del mensaje', enum: ['user', 'assistant'] })
	@IsString()
	@IsNotEmpty()
	role: 'user' | 'assistant';

	@ApiProperty({ description: 'Contenido del mensaje' })
	@IsString()
	@IsNotEmpty()
	content: string;
}

export class SendMessageDto {
	@ApiProperty({ description: 'Mensaje del usuario' })
	@IsString()
	@IsNotEmpty()
	message: string;

	@ApiPropertyOptional({ description: 'ID de conversación existente' })
	@IsString()
	@IsOptional()
	conversation_id?: string;

	@ApiPropertyOptional({ description: 'Prompt del sistema personalizado' })
	@IsString()
	@IsOptional()
	system_prompt?: string;

	@ApiPropertyOptional({ description: 'Historial de mensajes previos', type: [MessageDto] })
	@IsArray()
	@IsOptional()
	@ValidateNested({ each: true })
	@Type(() => MessageDto)
	messages?: MessageDto[];

	@ApiPropertyOptional({ description: 'Habilitar uso de skills', default: true })
	@IsOptional()
	use_skills?: boolean;

	@ApiProperty({ description: 'Holding ID (obligatorio)' })
	@IsString()
	@IsNotEmpty()
	holding_id: string;
}

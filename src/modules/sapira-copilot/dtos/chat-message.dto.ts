import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';

class MessageHistoryDto {
	@ApiProperty({ description: 'Rol del mensaje', enum: ['user', 'assistant'] })
	@IsString()
	@IsNotEmpty()
	role: 'user' | 'assistant';

	@ApiProperty({ description: 'Contenido del mensaje' })
	@IsString()
	@IsNotEmpty()
	content: string;
}

export class ChatMessageDto {
	@ApiProperty({ description: 'Mensaje del usuario' })
	@IsString()
	@IsNotEmpty()
	message: string;

	@ApiPropertyOptional({ description: 'ID de sesión de chat existente' })
	@IsString()
	@IsOptional()
	session_id?: string;

	@ApiPropertyOptional({ description: 'Contexto del proyecto o workspace' })
	@IsString()
	@IsOptional()
	context?: string;

	@ApiPropertyOptional({ description: 'Historial de mensajes previos', type: [MessageHistoryDto] })
	@IsArray()
	@IsOptional()
	@ValidateNested({ each: true })
	@Type(() => MessageHistoryDto)
	history?: MessageHistoryDto[];

	@ApiProperty({ description: 'Holding ID (obligatorio)' })
	@IsString()
	@IsNotEmpty()
	holding_id: string;
}

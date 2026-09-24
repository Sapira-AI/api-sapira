import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

import { CLIENT_ACTIVITY_TYPES, type ClientActivityType } from '../client-activity.service';
import { CLIENT_DOCUMENT_MAX_BYTES, CLIENT_DOCUMENT_MIME_TYPES } from '../client-documents.service';

/** `GET /clients/:id/activity`: `types` separados por coma (p. ej. `note,invoice`). */
export class QueryClientActivityDto {
	@ApiPropertyOptional({ description: 'Tipos de evento, separados por coma', example: 'note,contract,invoice' })
	@Transform(({ value }) =>
		typeof value === 'string'
			? value
					.split(',')
					.map((type) => type.trim())
					.filter(Boolean)
			: value
	)
	@IsArray()
	@ArrayMaxSize(CLIENT_ACTIVITY_TYPES.length)
	@IsIn(CLIENT_ACTIVITY_TYPES, { each: true })
	@IsOptional()
	types?: ClientActivityType[];

	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 30 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	limit?: number;
}

export class CreateActivityNoteDto {
	@ApiProperty({ description: 'Texto de la nota (1–5.000 caracteres)' })
	@IsString()
	@Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
	@MinLength(1)
	@MaxLength(5000)
	body!: string;
}

/** Paso 1 de la subida: datos del archivo para validar y firmar. */
export class PrepareDocumentUploadDto {
	@ApiProperty({ description: 'Nombre original del archivo' })
	@IsString()
	@MinLength(1)
	@MaxLength(200)
	name!: string;

	@ApiProperty({ enum: CLIENT_DOCUMENT_MIME_TYPES })
	@IsIn(CLIENT_DOCUMENT_MIME_TYPES)
	mime_type!: string;

	@ApiProperty({ description: 'Tamaño en bytes (máx. 20 MB)' })
	@IsInt()
	@Min(1)
	@Max(CLIENT_DOCUMENT_MAX_BYTES)
	size!: number;
}

/** Paso 3: confirma la subida (el archivo ya está en Storage) y registra el documento. */
export class ConfirmDocumentUploadDto {
	@ApiProperty()
	@IsUUID()
	document_id!: string;

	@ApiProperty({ description: 'Ruta devuelta por el paso 1' })
	@IsString()
	@MaxLength(400)
	path!: string;

	@ApiProperty()
	@IsString()
	@MinLength(1)
	@MaxLength(200)
	name!: string;

	@ApiProperty({ enum: CLIENT_DOCUMENT_MIME_TYPES })
	@IsIn(CLIENT_DOCUMENT_MIME_TYPES)
	mime_type!: string;

	@ApiPropertyOptional({ description: 'Razón social del cliente a la que corresponde' })
	@IsUUID()
	@IsOptional()
	client_entity_id?: string;
}

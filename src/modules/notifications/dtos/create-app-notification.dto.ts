import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

class NotificationRecipientsDto {
	@IsOptional()
	@IsArray()
	@ArrayUnique()
	@IsUUID('4', { each: true })
	user_ids?: string[];

	@IsOptional()
	@IsArray()
	@ArrayUnique()
	@IsUUID('4', { each: true })
	role_ids?: string[];

	@IsOptional()
	@IsBoolean()
	include_super_admins?: boolean;

	/** Todos los miembros activos del holding (novedades del sistema). */
	@IsOptional()
	@IsBoolean()
	all_members?: boolean;
}

export class CreateAppNotificationDto {
	@IsString()
	@MaxLength(120)
	source!: string;

	@IsString()
	@MaxLength(120)
	type!: string;

	@IsOptional()
	@IsIn(['info', 'warning', 'error'])
	severity?: 'info' | 'warning' | 'error';

	@IsString()
	@MaxLength(255)
	title!: string;

	@IsString()
	message!: string;

	@IsOptional()
	@IsString()
	recommendation?: string;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	action_type?: string;

	@IsOptional()
	@IsObject()
	action_payload?: Record<string, unknown>;

	@IsOptional()
	@IsObject()
	metadata?: Record<string, unknown>;

	@IsOptional()
	@IsString()
	@MaxLength(255)
	deduplication_key?: string;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	resource_type?: string;

	@IsOptional()
	@IsUUID('4')
	resource_id?: string;

	/**
	 * Escalón del aviso (p. ej. días al vencimiento de una renovación). Si cambia en `createOrUpdate`, la alerta vuelve a "sin leer" para
	 * todos (igual que si sube la gravedad). Se guarda en `metadata.escalation_step`.
	 */
	@IsOptional()
	escalation_step?: string | number;

	@IsOptional()
	@ValidateNested()
	@Type(() => NotificationRecipientsDto)
	recipients?: NotificationRecipientsDto;
}

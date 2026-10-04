import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	IsBoolean,
	IsIn,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { AVATAR_PRESET_IDS, PASSWORD_DIGIT, PASSWORD_LETTER, PASSWORD_MAX, PASSWORD_MIN } from '../me.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const AVATAR_KINDS = ['initials', 'preset', 'upload'] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** Avatar a elegir en `PATCH /me/profile`: iniciales o un preset. `upload` se rechaza en el servicio (la foto entra por `/me/avatar/*`). */
export class AvatarChoiceDto {
	@ApiProperty({ enum: AVATAR_KINDS })
	@IsIn(AVATAR_KINDS as unknown as string[], { message: 'El avatar no es válido' })
	kind!: AvatarKind;

	@ApiPropertyOptional({ enum: AVATAR_PRESET_IDS as string[], description: 'Obligatorio si kind = preset' })
	@ValidateIf((dto: AvatarChoiceDto) => dto.kind === 'preset')
	@IsIn(AVATAR_PRESET_IDS as string[], { message: 'Elige un avatar de la lista' })
	preset_id?: string;
}

export class UpdateMyProfileDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
	@MaxLength(100, { message: 'El nombre no puede superar 100 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ type: AvatarChoiceDto })
	@IsObject({ message: 'El avatar no es válido' })
	@ValidateNested()
	@Type(() => AvatarChoiceDto)
	@IsOptional()
	avatar?: AvatarChoiceDto;
}

export class AvatarUploadDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del archivo debe ser texto' })
	@MinLength(1, { message: 'Falta el nombre del archivo' })
	@MaxLength(200, { message: 'El nombre del archivo no puede superar 200 caracteres' })
	file_name!: string;

	@ApiProperty({ enum: ['image/png', 'image/jpeg', 'image/webp'] })
	@IsString({ message: 'El tipo de archivo debe ser texto' })
	mime_type!: string;

	@ApiProperty({ description: 'Bytes' })
	@Type(() => Number)
	@IsInt({ message: 'El tamaño del archivo no es válido' })
	@Min(1, { message: 'El archivo está vacío' })
	size!: number;
}

export class AvatarConfirmDto {
	@ApiProperty({ example: 'users/<users.id>/<uuid>.png', description: 'El `path` que devolvió upload-url' })
	@IsString({ message: 'La foto no es válida' })
	@MaxLength(300, { message: 'La foto no es válida' })
	path!: string;
}

export class ChangePasswordDto {
	@ApiProperty()
	@IsString({ message: 'Escribe tu contraseña actual' })
	@MinLength(1, { message: 'Escribe tu contraseña actual' })
	@MaxLength(PASSWORD_MAX, { message: 'La contraseña actual no es correcta' })
	current_password!: string;

	@ApiProperty({ description: `${PASSWORD_MIN}–${PASSWORD_MAX} caracteres, al menos una letra y un número` })
	@IsString({ message: 'La contraseña nueva debe ser texto' })
	@MinLength(PASSWORD_MIN, { message: `La contraseña nueva debe tener al menos ${PASSWORD_MIN} caracteres` })
	@MaxLength(PASSWORD_MAX, { message: `La contraseña nueva no puede superar ${PASSWORD_MAX} caracteres` })
	@Matches(PASSWORD_LETTER, { message: 'La contraseña nueva debe tener al menos una letra' })
	@Matches(PASSWORD_DIGIT, { message: 'La contraseña nueva debe tener al menos un número' })
	new_password!: string;

	@ApiPropertyOptional({ default: false, description: 'Cerrar las demás sesiones (mantiene esta)' })
	@IsBoolean({ message: 'Indica sí o no para cerrar las demás sesiones' })
	@IsOptional()
	sign_out_other_sessions?: boolean;
}

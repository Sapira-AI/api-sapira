import { Body, Controller, Get, HttpCode, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { AvatarConfirmDto, AvatarUploadDto, ChangePasswordDto, UpdateMyProfileDto } from './dtos/me.dto';
import { ACCOUNT_SECURITY_THROTTLE, AVATAR_UPLOAD_THROTTLE } from './me.constants';
import { MeCaller, MeService } from './me.service';

interface MeRequest {
	user?: { id?: string; sub?: string; email?: string; identities?: unknown };
	headers?: Record<string, string | string[] | undefined>;
}

/** Datos de la sesión: `sub` de Auth, correo, identidades (las trae `SupabaseAuthGuard` desde `getUser`) y el JWT crudo. */
export function callerOf(req: MeRequest): MeCaller {
	const header = req.headers?.authorization;
	const raw = Array.isArray(header) ? header[0] : header;
	const jwt = typeof raw === 'string' && /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, '').trim() : null;

	return {
		authId: String(req.user?.sub ?? req.user?.id ?? ''),
		email: req.user?.email ?? null,
		jwt: jwt || null,
		authUser: (req.user as MeCaller['authUser']) ?? null,
	};
}

/**
 * Mi perfil (contrato `docs/v2-rediseno/contrato-api-mi-perfil.md`). Solo sesión: todo es del usuario autenticado, sin holding
 * (no usa `HoldingScopeGuard` ni permisos; nada de `user_id`/`holding_id` en query o body).
 */
@ApiTags('Mi perfil')
@Controller('me')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class MeController {
	constructor(private readonly me: MeService) {}

	@Get('profile')
	@ApiOperation({ summary: 'Mi perfil: nombre, correo, avatar, con qué entro, último acceso y mis holdings con rol' })
	getProfile(@Request() req: MeRequest) {
		return this.me.getProfile(callerOf(req));
	}

	@Patch('profile')
	@ApiOperation({ summary: 'Cambiar mi nombre y avatar (iniciales o preset; la foto va por /me/avatar/*)' })
	updateProfile(@Request() req: MeRequest, @Body() body: UpdateMyProfileDto) {
		return this.me.updateProfile(callerOf(req), body);
	}

	@Post('avatar/upload-url')
	@HttpCode(200)
	@Throttle(AVATAR_UPLOAD_THROTTLE)
	@ApiOperation({ summary: 'URL firmada para subir mi foto (bucket público user-avatars; PNG/JPG/WEBP, 2 MB)' })
	avatarUploadUrl(@Request() req: MeRequest, @Body() body: AvatarUploadDto) {
		return this.me.prepareAvatarUpload(callerOf(req), body);
	}

	@Post('avatar/confirm')
	@HttpCode(200)
	@ApiOperation({ summary: 'Guardar la foto subida como mi avatar (borra la anterior)' })
	confirmAvatar(@Request() req: MeRequest, @Body() body: AvatarConfirmDto) {
		return this.me.confirmAvatar(callerOf(req), body);
	}

	@Post('sessions/revoke-all')
	@HttpCode(200)
	@Throttle(ACCOUNT_SECURITY_THROTTLE)
	@ApiOperation({ summary: 'Cerrar sesión en todos los dispositivos (incluido este)' })
	@ApiResponse({ status: 200, description: '{ message }; el front cierra la sesión local y va a /login' })
	revokeAll(@Request() req: MeRequest) {
		return this.me.revokeAllSessions(callerOf(req));
	}

	@Post('password')
	@HttpCode(200)
	@Throttle(ACCOUNT_SECURITY_THROTTLE)
	@ApiOperation({ summary: 'Cambiar mi contraseña (exige la actual)' })
	@ApiResponse({ status: 400, description: 'Contraseña actual incorrecta o nueva sin las reglas' })
	@ApiResponse({ status: 409, description: 'La cuenta no tiene contraseña (entra con Google o Microsoft)' })
	changePassword(@Request() req: MeRequest, @Body() body: ChangePasswordDto) {
		return this.me.changePassword(callerOf(req), body);
	}
}

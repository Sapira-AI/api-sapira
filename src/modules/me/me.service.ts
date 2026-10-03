import { randomUUID } from 'crypto';

import {
	BadGatewayException,
	BadRequestException,
	ConflictException,
	HttpException,
	HttpStatus,
	Injectable,
	Logger,
	NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AuthAdminError, SupabaseAdminService } from '@/auth/accounts/supabase-admin.service';
import { validationException } from '@/core/utils/validation-errors';
import { SettingsStorageService } from '@/modules/settings/settings-storage.service';

import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES, AVATAR_PRESET_IDS, USER_AVATARS_BUCKET } from './me.constants';
import { userAvatar, type UserAvatar } from './user-avatar';

import type { AvatarConfirmDto, AvatarUploadDto, ChangePasswordDto, UpdateMyProfileDto } from './dtos/me.dto';
import type { User as AuthUser } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

/** Quién llama: `id` de Auth, correo de Auth, identidades (si el guard las trajo) y el JWT crudo (para `signOut`). */
export interface MeCaller {
	authId: string;
	email: string | null;
	jwt: string | null;
	authUser: Partial<AuthUser> | null;
}

/** Mismo avatar que el resto de la API (`user-avatar.ts`). */
export type MyAvatar = UserAvatar;
export type LoginProvider = 'password' | 'google' | 'azure';
export type AccountEvent = 'password_changed' | 'sessions_revoked';

export interface MyProfile {
	id: string;
	name: string | null;
	email: string;
	avatar: MyAvatar;
	avatar_presets: readonly string[];
	providers: LoginProvider[];
	has_password: boolean;
	last_access_at: unknown;
	is_super_admin: boolean;
	holdings: Array<{ id: string; name: string; logo_url: string | null; role_name: string | null; selected: boolean }>;
}

const MSG = {
	notFound: 'Usuario no encontrado',
	noChanges: 'No hay cambios para guardar',
	uploadInPatch: 'La foto se sube con "Subir foto"',
	badPhoto: 'La foto no es válida',
	notUploaded: 'La foto no terminó de subirse: vuelve a intentarlo',
	tooBig: 'La foto no puede superar 2 MB',
	badMime: 'La foto debe ser PNG, JPG o WEBP',
	noPassword: 'Tu cuenta no tiene contraseña: entra con Google o Microsoft, o crea una desde "¿Olvidaste tu contraseña?"',
	wrongPassword: 'La contraseña actual no es correcta',
	samePassword: 'La contraseña nueva debe ser distinta de la actual',
	weakPassword: 'La contraseña nueva es demasiado débil o aparece en filtraciones conocidas: elige otra',
	authDown: 'No se pudo completar la acción en tu cuenta: vuelve a intentarlo en unos minutos',
	tooMany: 'Demasiados intentos: espera unos minutos y vuelve a intentarlo',
	revoked: 'Cerramos tu sesión en todos los dispositivos',
	passwordChanged: 'Contraseña actualizada',
} as const;

const KNOWN_PROVIDERS: Record<string, LoginProvider> = { google: 'google', azure: 'azure' };
const PROVIDER_ORDER: LoginProvider[] = ['password', 'google', 'azure'];

/**
 * Mi perfil (contrato `docs/v2-rediseno/contrato-api-mi-perfil.md`): todo sobre el usuario de la sesión (`users.auth_id` = `sub`), sin
 * holding. Nombre y avatar en `users` (`name`, `avatar_preset`, `avatar_path`); foto por URL firmada al bucket público `user-avatars`
 * (Storage con `SettingsStorageService`, mismo patrón que el logo del holding); cuenta de Auth solo por `SupabaseAdminService`.
 * Cambio de contraseña y cierre global de sesiones quedan en `user_access_events` (holding NULL).
 */
@Injectable()
export class MeService {
	private readonly logger = new Logger(MeService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly storage: SettingsStorageService,
		private readonly admin: SupabaseAdminService,
		private readonly config: ConfigService
	) {}

	// ------------------------------------------------------------------ perfil

	async getProfile(caller: MeCaller): Promise<MyProfile> {
		const user = await this.user(caller.authId);
		const [holdings, account] = await Promise.all([this.holdings(user), this.account(caller)]);

		return {
			id: String(user.id),
			name: (user.name as string | null) ?? null,
			email: String(user.email ?? ''),
			avatar: this.avatarOf(user),
			avatar_presets: AVATAR_PRESET_IDS,
			providers: account.providers,
			has_password: account.hasPassword,
			last_access_at: user.last_access ?? null,
			is_super_admin: user.is_super_admin === true,
			holdings,
		};
	}

	async updateProfile(caller: MeCaller, dto: UpdateMyProfileDto): Promise<MyProfile> {
		if (dto.name === undefined && dto.avatar === undefined) throw validationException([{ field: 'name', message: MSG.noChanges }]);
		if (dto.avatar?.kind === 'upload') throw validationException([{ field: 'avatar.kind', message: MSG.uploadInPatch }]);
		const user = await this.user(caller.authId);
		const sets: string[] = [];
		const params: unknown[] = [user.id];

		if (dto.name !== undefined) {
			params.push(dto.name);
			sets.push(`name = $${params.length}`);
		}
		if (dto.avatar) {
			params.push(dto.avatar.kind === 'preset' ? dto.avatar.preset_id : null);
			sets.push(`avatar_preset = $${params.length}`, 'avatar_path = NULL');
		}
		await this.dataSource.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
		if (dto.avatar && user.avatar_path) await this.storage.remove(USER_AVATARS_BUCKET, String(user.avatar_path));

		return this.getProfile(caller);
	}

	// ------------------------------------------------------------------ foto

	async prepareAvatarUpload(caller: MeCaller, input: AvatarUploadDto) {
		const extension = AVATAR_MIME_TYPES[input.mime_type];

		if (!extension) throw validationException([{ field: 'mime_type', message: MSG.badMime }]);
		if (input.size > AVATAR_MAX_BYTES) throw validationException([{ field: 'size', message: MSG.tooBig }]);
		const user = await this.user(caller.authId);
		const path = `users/${String(user.id)}/${randomUUID()}.${extension}`;
		const upload = await this.storage.createUploadUrl(USER_AVATARS_BUCKET, path);

		return { path, upload_url: upload.signedUrl, token: upload.token, max_bytes: AVATAR_MAX_BYTES };
	}

	async confirmAvatar(caller: MeCaller, input: AvatarConfirmDto): Promise<MyProfile> {
		const user = await this.user(caller.authId);

		if (!isOwnAvatarPath(input.path, String(user.id))) throw validationException([{ field: 'path', message: MSG.badPhoto }]);
		if (input.path === user.avatar_path) return this.getProfile(caller);
		const size = await this.storage.objectSize(USER_AVATARS_BUCKET, input.path);

		if (size === null) throw new ConflictException(MSG.notUploaded);
		if (size > AVATAR_MAX_BYTES) {
			await this.storage.remove(USER_AVATARS_BUCKET, input.path);
			throw validationException([{ field: 'path', message: MSG.tooBig }]);
		}
		await this.dataSource.query(`UPDATE users SET avatar_path = $2, avatar_preset = NULL WHERE id = $1`, [user.id, input.path]);
		if (user.avatar_path) await this.storage.remove(USER_AVATARS_BUCKET, String(user.avatar_path));

		return this.getProfile(caller);
	}

	// ------------------------------------------------------------------ seguridad de la cuenta

	async revokeAllSessions(caller: MeCaller): Promise<{ message: string }> {
		const user = await this.user(caller.authId);

		if (!caller.jwt) throw new BadRequestException('Falta el token de la sesión');
		await this.callAuth(() => this.admin.signOut(caller.jwt as string, 'global'));
		await this.logAccountEvent(String(user.id), 'sessions_revoked');

		return { message: MSG.revoked };
	}

	async changePassword(caller: MeCaller, dto: ChangePasswordDto): Promise<{ message: string }> {
		const user = await this.user(caller.authId);
		const account = await this.account(caller);

		if (!account.hasPassword) throw new ConflictException(MSG.noPassword);
		if (dto.new_password === dto.current_password) throw validationException([{ field: 'new_password', message: MSG.samePassword }]);
		const email = caller.email ?? String(user.email ?? '');
		const valid = await this.callAuth(() => this.admin.verifyPassword(email, dto.current_password));

		if (!valid) throw validationException([{ field: 'current_password', message: MSG.wrongPassword }]);
		await this.callAuth(() => this.admin.updatePassword(caller.authId, dto.new_password), true);
		const signOutOthers = dto.sign_out_other_sessions === true && Boolean(caller.jwt);

		if (signOutOthers) {
			// La contraseña ya cambió: si cerrar las demás sesiones falla, se informa en el log y no se revierte el cambio.
			await this.admin
				.signOut(caller.jwt as string, 'others')
				.catch((cause: Error) => this.logger.warn(`signOut(others) falló: ${cause.message}`));
		}
		await this.logAccountEvent(String(user.id), 'password_changed', { signed_out_others: signOutOthers });

		return { message: MSG.passwordChanged };
	}

	// ------------------------------------------------------------------ apoyo

	private async user(authId: string): Promise<Row> {
		const [row] = (await this.dataSource.query(
			`SELECT id, name, email, role_id, last_access, COALESCE(is_super_admin, false) AS is_super_admin, avatar_preset, avatar_path
			FROM users WHERE auth_id = $1 LIMIT 1`,
			[authId]
		)) as Row[];

		if (!authId || !row) throw new NotFoundException(MSG.notFound);

		return row;
	}

	/** Membresías activas con el rol de `users.role_id` solo en el holding al que pertenece ese rol (como `PermissionsService`). */
	private async holdings(user: Row): Promise<MyProfile['holdings']> {
		const rows = (await this.dataSource.query(
			`SELECT h.id, h.name, h.logo_url, COALESCE(uh.selected, false) AS selected, r.name AS role_name
			FROM user_holdings uh
			JOIN company_holdings h ON h.id = uh.holding_id
			LEFT JOIN roles r ON r.id = $2 AND r.holding_id = uh.holding_id
			WHERE uh.user_id = $1 AND uh.is_active = true
			ORDER BY h.name`,
			[user.id, user.role_id ?? null]
		)) as Row[];
		const superAdmin = user.is_super_admin === true;

		return rows.map((row) => ({
			id: String(row.id),
			name: String(row.name ?? ''),
			logo_url: (row.logo_url as string | null) ?? null,
			role_name: superAdmin ? 'Super Admin' : ((row.role_name as string | null) ?? null),
			selected: row.selected === true,
		}));
	}

	/** Con qué entra: identidades de Auth + si tiene contraseña (`auth.users.encrypted_password`, leído como booleano). */
	private async account(caller: MeCaller): Promise<{ providers: LoginProvider[]; hasPassword: boolean }> {
		const authUser = Array.isArray(caller.authUser?.identities) ? caller.authUser : await this.callAuth(() => this.admin.getUser(caller.authId));
		const identities = authUser?.identities ?? [];
		const emailIdentity = identities.some((identity) => identity.provider === 'email');
		let hasPassword: boolean;

		try {
			const [row] = (await this.dataSource.query(
				`SELECT (encrypted_password IS NOT NULL AND encrypted_password <> '') AS has_password FROM auth.users WHERE id = $1`,
				[caller.authId]
			)) as Row[];

			hasPassword = row?.has_password === true;
		} catch (cause) {
			this.logger.warn(`No se pudo leer si la cuenta tiene contraseña: ${(cause as Error).message}`);
			hasPassword = emailIdentity && Boolean(identities.find((identity) => identity.provider === 'email')?.last_sign_in_at);
		}
		const providers = new Set<LoginProvider>();

		if (hasPassword) providers.add('password');
		for (const identity of identities) {
			const provider = KNOWN_PROVIDERS[identity.provider];

			if (provider) providers.add(provider);
		}

		return { providers: PROVIDER_ORDER.filter((provider) => providers.has(provider)), hasPassword };
	}

	private avatarOf(user: Row): MyAvatar {
		return userAvatar(user, this.config.get<string>('SUPABASE_URL'));
	}

	/** Traduce fallas de Supabase Auth: límite → 429; contraseña rechazada (al cambiarla) → 400; el resto → 502. */
	private async callAuth<T>(action: () => Promise<T>, changingPassword = false): Promise<T> {
		try {
			return await action();
		} catch (cause) {
			if (!(cause instanceof AuthAdminError)) throw cause;
			const code = cause.code ?? '';

			if (/rate_limit/.test(code)) throw new HttpException(MSG.tooMany, HttpStatus.TOO_MANY_REQUESTS);
			if (changingPassword && code === 'same_password') throw validationException([{ field: 'new_password', message: MSG.samePassword }]);
			if (changingPassword && (code === 'weak_password' || /password/i.test(cause.message))) {
				throw validationException([{ field: 'new_password', message: MSG.weakPassword }]);
			}
			throw new BadGatewayException(MSG.authDown);
		}
	}

	private async logAccountEvent(userId: string, action: AccountEvent, details: Record<string, unknown> = {}): Promise<void> {
		try {
			await this.dataSource.query(
				`INSERT INTO user_access_events (holding_id, user_id, actor_user_id, action, details) VALUES (NULL, $1, $1, $2, $3::jsonb)`,
				[userId, action, JSON.stringify(details)]
			);
		} catch (cause) {
			// La acción en Auth ya ocurrió: no se informa como error a la persona; queda en el log.
			this.logger.error(`No se pudo registrar ${action} de ${userId}: ${(cause as Error).message}`);
		}
	}
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Ruta de foto válida para la persona: `users/<su id>/<uuid>.<png|jpg|webp>` (la que emitió upload-url). */
export function isOwnAvatarPath(path: string, userId: string): boolean {
	const match = new RegExp(`^users/(${UUID})/${UUID}\\.(png|jpg|webp)$`, 'i').exec(path);

	return Boolean(match) && match?.[1].toLowerCase() === userId.toLowerCase();
}

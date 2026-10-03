import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type InviteLinkType = 'invite' | 'magiclink';
/** Tipos de enlace que genera la API: invitación (`invite` / `magiclink`) y recuperar contraseña (`recovery`). */
export type AuthLinkType = InviteLinkType | 'recovery';

export interface GeneratedLink {
	type: AuthLinkType;
	/** `hashed_token` de Supabase: va en `/auth/confirm?token_hash=…` del front (no es el enlace de Supabase). */
	hashedToken: string;
	authUserId: string;
}

/** Falla de Supabase Auth (red, 4xx/5xx). Los servicios la traducen a un 502 con mensaje de negocio. */
export class AuthAdminError extends Error {
	constructor(
		message: string,
		readonly code?: string
	) {
		super(message);
		this.name = 'AuthAdminError';
	}
}

/** Bloqueo "permanente" (100 años): Supabase no tiene un ban sin duración. `none` lo quita. */
export const BAN_FOREVER = '876000h';

/**
 * Supabase Auth admin con la clave de servicio, **solo desde la API** (regla de `AGENTS.md`: Supabase en el front es solo sesión).
 * Mismo patrón que `SettingsStorageService`: cliente perezoso, 503 si faltan `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`.
 * Tres operaciones y nada más: generar enlaces (invitación y recuperar contraseña, sin que Supabase mande correo: lo manda `AuthMailer`),
 * bloquear/desbloquear y borrar la cuenta. Lo usan Configuración (usuarios) y `POST /auth/password-recovery`.
 */
@Injectable()
export class SupabaseAdminService {
	private readonly logger = new Logger(SupabaseAdminService.name);
	private client: SupabaseClient | null = null;

	constructor(private readonly config: ConfigService) {}

	/** 503 antes de escribir nada si la API no puede administrar cuentas. */
	assertConfigured(): void {
		this.supabase();
	}

	private supabase(): SupabaseClient {
		if (!this.client) {
			const url = this.config.get<string>('SUPABASE_URL');
			const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

			if (!url || !key) throw new ServiceUnavailableException('La invitación de usuarios no está configurada');
			this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
		}

		return this.client;
	}

	/**
	 * Enlace de un solo uso. `recovery` exige que la cuenta exista. `invite` crea la cuenta (sin contraseña) con `full_name` en la metadata; si Supabase responde que el correo ya
	 * tiene cuenta (`email_exists`), cae a `magiclink` sobre esa cuenta. `generateLink` **no** manda correo: lo manda `InvitationMailer`.
	 */
	async generateLink(params: { type: AuthLinkType; email: string; fullName: string | null; redirectTo: string }): Promise<GeneratedLink> {
		const { data, error } =
			params.type === 'recovery'
				? await this.supabase().auth.admin.generateLink({ type: 'recovery', email: params.email, options: { redirectTo: params.redirectTo } })
				: await this.supabase().auth.admin.generateLink({
						type: params.type,
						email: params.email,
						options: { redirectTo: params.redirectTo, ...(params.fullName ? { data: { full_name: params.fullName } } : {}) },
					});

		if (error) {
			const code = (error as { code?: string }).code;

			if (params.type === 'invite' && (code === 'email_exists' || /already been registered/i.test(error.message))) {
				return this.generateLink({ ...params, type: 'magiclink' });
			}
			this.logger.error(`generateLink(${params.type}) falló: ${code ?? ''} ${error.message}`);
			throw new AuthAdminError(error.message, code);
		}
		const hashedToken = data?.properties?.hashed_token;
		const authUserId = data?.user?.id;

		if (!hashedToken || !authUserId) throw new AuthAdminError('Supabase no devolvió el enlace');

		return { type: params.type, hashedToken, authUserId };
	}

	/** Bloquea (`true`) o desbloquea la cuenta en Auth: un bloqueado no puede iniciar sesión en ningún front. */
	async setBanned(authUserId: string, banned: boolean): Promise<void> {
		const { error } = await this.supabase().auth.admin.updateUserById(authUserId, { ban_duration: banned ? BAN_FOREVER : 'none' });

		if (error) {
			this.logger.error(`updateUserById(${authUserId}, ban=${banned}) falló: ${error.message}`);
			throw new AuthAdminError(error.message, (error as { code?: string }).code);
		}
	}

	async deleteUser(authUserId: string): Promise<void> {
		const { error } = await this.supabase().auth.admin.deleteUser(authUserId);

		if (error) {
			this.logger.error(`deleteUser(${authUserId}) falló: ${error.message}`);
			throw new AuthAdminError(error.message, (error as { code?: string }).code);
		}
	}
}

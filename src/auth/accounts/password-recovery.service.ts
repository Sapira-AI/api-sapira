import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { DataSource } from 'typeorm';

import { authConfirmUrl, AuthMailer } from './auth-mailer';
import { SupabaseAdminService } from './supabase-admin.service';

/** Respuesta única de `POST /auth/password-recovery`: no revela si el correo tiene cuenta. */
export const RECOVERY_MESSAGE = 'Si el correo tiene una cuenta en Sapira, te enviamos un enlace para crear una nueva contraseña.';
export const RECOVERY_NEXT = '/bienvenida?modo=recuperar';
/** Por correo: uno por minuto y cinco por día (contados en el storage del throttler, sin revelar nada: se omite en silencio). */
export const RECOVERY_COOLDOWN_MS = 60_000;
export const RECOVERY_DAILY_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

/**
 * Recuperar contraseña desde la API (contrato Configuración §10.6): el correo de Supabase no tiene formato, así que la API genera el
 * enlace `recovery` con la clave de servicio y lo manda con `AuthMailer`. Siempre responde lo mismo y **no espera** el trabajo (mismo
 * tiempo de respuesta exista o no el correo). Solo cuentas existentes (`users.auth_id`) cuyo estado no es `Inactivo`.
 */
@Injectable()
export class PasswordRecoveryService {
	private readonly logger = new Logger(PasswordRecoveryService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly admin: SupabaseAdminService,
		private readonly mailer: AuthMailer,
		private readonly config: ConfigService,
		@InjectThrottlerStorage() private readonly storage: ThrottlerStorage
	) {}

	request(rawEmail: string): { message: string } {
		const email = rawEmail.trim().toLowerCase();

		void this.process(email).catch((error: Error) => this.logger.error(`Recuperar contraseña falló: ${error.message}`));

		return { message: RECOVERY_MESSAGE };
	}

	/** Público para los tests; el endpoint no lo espera. Devuelve qué hizo (solo para logs y tests). */
	async process(email: string): Promise<'sent' | 'failed' | 'skipped_cooldown' | 'skipped_no_account' | 'skipped_config'> {
		if (await this.inCooldown(email)) return 'skipped_cooldown';
		const [user] = (await this.dataSource.query(
			`SELECT id, name, auth_id FROM users
			WHERE lower(email) = $1 AND auth_id IS NOT NULL AND COALESCE(status, '') <> 'Inactivo' LIMIT 1`,
			[email]
		)) as Row[];

		if (!user) return 'skipped_no_account';
		const landing = this.config.get<string>('INVITE_LANDING_URL');
		const redirectTo = authConfirmUrl(landing, 'recovery', RECOVERY_NEXT);

		if (!redirectTo) {
			this.logger.error('INVITE_LANDING_URL no configurada: no se puede recuperar contraseña');

			return 'skipped_config';
		}
		const link = await this.admin.generateLink({ type: 'recovery', email, fullName: null, redirectTo });
		const url = authConfirmUrl(landing, 'recovery', RECOVERY_NEXT, link.hashedToken) as string;
		const result = await this.mailer.sendRecovery(
			email,
			{ name: (user.name as string | null) ?? null, link: url },
			`recovery-${String(user.id)}-${link.hashedToken.slice(0, 16)}`
		);

		this.logger.log(`Recuperar contraseña para ${String(user.id)}: ${result.status}`);

		return result.status;
	}

	/** Cooldown por correo en el storage del throttler (sirve también a correos sin cuenta: no se distingue). */
	private async inCooldown(email: string): Promise<boolean> {
		const minute = await this.storage.increment(`password-recovery:min:${email}`, RECOVERY_COOLDOWN_MS, 1, 0, 'password-recovery');
		const day = await this.storage.increment(`password-recovery:day:${email}`, DAY_MS, RECOVERY_DAILY_LIMIT, 0, 'password-recovery');

		return minute.totalHits > 1 || day.totalHits > RECOVERY_DAILY_LIMIT;
	}
}

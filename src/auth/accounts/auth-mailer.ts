import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { validationException } from '@/core/utils/validation-errors';

import { InvitationEmailValues, renderInvitationEmail } from './email-templates/invitation';
import { RenderedEmail } from './email-templates/layout';
import { RecoveryEmailValues, renderRecoveryEmail } from './email-templates/recovery';

export const DEFAULT_AUTH_FROM = 'Sapira <noreply@aisapira.com>';
const RESEND_URL = 'https://api.resend.com/emails';

export type MailResult = { status: 'sent'; id: string | null } | { status: 'failed'; error: string };

/**
 * Correos de cuenta por Resend (HTTP directo, `RESEND_API_KEY`), remitente `INVITE_FROM` (default `Sapira <noreply@aisapira.com>`):
 * invitación (Configuración · usuarios) y recuperar contraseña (`POST /auth/password-recovery`). Plantillas en `email-templates/`
 * (layout común con la marca). **Nunca lanza**: si Resend falla o no está configurado devuelve `failed`. `Idempotency-Key` evita
 * duplicados si la API reintenta. Logo: `EMAIL_LOGO_URL` (opcional).
 */
@Injectable()
export class AuthMailer {
	private readonly logger = new Logger(AuthMailer.name);

	constructor(private readonly config: ConfigService) {}

	/** Solo invitaciones: 400 si `INVITE_TEST_ALLOWLIST` está definida (QA) y el correo no calza. Sin la variable, no limita. */
	assertAllowedRecipient(email: string): void {
		const raw = this.config.get<string>('INVITE_TEST_ALLOWLIST');

		if (raw === undefined || raw === null || raw.trim() === '') return;
		if (!isAllowedRecipient(email, raw)) {
			throw validationException([{ field: 'email', message: 'En este ambiente solo se puede invitar a correos autorizados para pruebas' }]);
		}
	}

	sendInvitation(to: string, values: Omit<InvitationEmailValues, 'logoUrl'>, idempotencyKey: string): Promise<MailResult> {
		return this.send(to, renderInvitationEmail({ ...values, logoUrl: this.logoUrl() }), idempotencyKey);
	}

	sendRecovery(to: string, values: Omit<RecoveryEmailValues, 'logoUrl'>, idempotencyKey: string): Promise<MailResult> {
		return this.send(to, renderRecoveryEmail({ ...values, logoUrl: this.logoUrl() }), idempotencyKey);
	}

	private logoUrl(): string | undefined {
		return this.config.get<string>('EMAIL_LOGO_URL') || undefined;
	}

	private async send(to: string, email: RenderedEmail, idempotencyKey: string): Promise<MailResult> {
		const apiKey = this.config.get<string>('RESEND_API_KEY');

		if (!apiKey) {
			this.logger.warn('RESEND_API_KEY no configurada: el correo no sale');

			return { status: 'failed', error: 'RESEND_API_KEY no configurada' };
		}
		const from = this.config.get<string>('INVITE_FROM') || DEFAULT_AUTH_FROM;

		try {
			const response = await fetch(RESEND_URL, {
				method: 'POST',
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ from, to: [to], subject: email.subject, html: email.html, text: email.text }),
			});
			const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };

			if (!response.ok) {
				this.logger.error(`Resend respondió ${response.status}: ${body.message ?? ''}`);

				return { status: 'failed', error: body.message ?? `HTTP ${response.status}` };
			}

			return { status: 'sent', id: body.id ?? null };
		} catch (error) {
			this.logger.error(`Resend no respondió: ${(error as Error).message}`);

			return { status: 'failed', error: (error as Error).message };
		}
	}
}

/** `aisapira.com, qa@cliente.cl` → el correo calza si es igual a un correo de la lista o su dominio es igual a un dominio de la lista. */
export function isAllowedRecipient(email: string, allowlist: string): boolean {
	const normalized = email.trim().toLowerCase();
	const domain = normalized.slice(normalized.lastIndexOf('@') + 1);

	return allowlist
		.split(/[,\s]+/)
		.map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
		.filter(Boolean)
		.some((entry) => (entry.includes('@') ? entry === normalized : entry === domain));
}

/** `${INVITE_LANDING_URL}/auth/confirm?token_hash=…&type=…&next=…` (sin token: `redirectTo` de Supabase). `null` si falta la variable. */
export function authConfirmUrl(landing: string | undefined, type: string, next: string, tokenHash?: string): string | null {
	const base = String(landing ?? '')
		.trim()
		.replace(/\/+$/, '');

	if (!base) return null;
	const params = new URLSearchParams();

	if (tokenHash) params.set('token_hash', tokenHash);
	params.set('type', type);
	params.set('next', next);

	return `${base}/auth/confirm?${params.toString()}`;
}

import * as fs from 'fs';
import * as path from 'path';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { actorTracker, forwardedIpTracker, jwtSubject, RECOVERY_THROTTLE } from './actor-throttle';
import { authConfirmUrl, AuthMailer, DEFAULT_AUTH_FROM, isAllowedRecipient } from './auth-mailer';
import { renderInvitationEmail } from './email-templates/invitation';
import { DEFAULT_LOGO_URL } from './email-templates/layout';
import { renderRecoveryEmail } from './email-templates/recovery';
import { PasswordRecoveryService, RECOVERY_MESSAGE } from './password-recovery.service';
import { SupabaseAdminService } from './supabase-admin.service';

import type { ThrottlerStorage } from '@nestjs/throttler';

/** Correos de cuenta y recuperar contraseña con Resend y Supabase Auth **mockeados** (`fetch` y el admin nunca salen a la red). */
const config = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const invitation = {
	inviterName: 'Domi <script>',
	holdingName: 'Hanka & "Co"',
	inviteeName: 'Ana',
	link: 'https://x.cl/auth/confirm?token_hash=a&type=invite',
};

describe('Plantillas de correo', () => {
	it('invitación: asunto, botón, vencimiento, layout de la marca y todo valor escapado', () => {
		const email = renderInvitationEmail(invitation);

		expect(email.subject).toBe('Domi <script> te invita a Hanka & "Co" en Sapira');
		expect(email.html).toContain('Aceptar invitación');
		expect(email.html).toContain('El enlace vence en 24 horas.');
		expect(email.html).not.toContain('<script>');
		expect(email.html).toContain('Domi &lt;script&gt;');
		expect(email.html).toContain('Hanka &amp; &quot;Co&quot;');
		expect(email.html).toContain('href="https://x.cl/auth/confirm?token_hash=a&amp;type=invite"');
		expect(email.html).toContain(`src="${DEFAULT_LOGO_URL}"`);
		expect(email.html).toContain('alt="Sapira"');
		expect(email.html).toContain('max-width:600px');
		expect(email.html).toContain('Sapira · <a href="https://aisapira.com"');
		expect(email.text).toContain('Aceptar invitación: https://x.cl/auth/confirm?token_hash=a&type=invite');
		expect(email.text).toContain('Sapira · aisapira.com');
	});

	it('el asunto no admite saltos de línea', () => {
		expect(renderInvitationEmail({ ...invitation, inviterName: 'A\r\nBcc: x@y.cl' }).subject).toBe(
			'A Bcc: x@y.cl te invita a Hanka & "Co" en Sapira'
		);
	});

	it('recuperar contraseña: título, botón y aviso', () => {
		const email = renderRecoveryEmail({ name: 'Ana <b>', link: 'https://x.cl/auth/confirm?token_hash=h&type=recovery' });

		expect(email.subject).toBe('Restablece tu contraseña de Sapira');
		expect(email.html).toContain('Restablece tu contraseña');
		expect(email.html).toContain('Crear nueva contraseña');
		expect(email.html).toContain('El enlace vence en 24 horas. Si no lo pediste, ignora este correo.');
		expect(email.html).toContain('Ana &lt;b&gt;');
	});

	it('genera los HTML de ejemplo para revisar en el navegador (SAPIRA_EMAIL_PREVIEW_DIR)', () => {
		const dir = process.env.SAPIRA_EMAIL_PREVIEW_DIR;

		if (!dir) return;
		fs.mkdirSync(dir, { recursive: true });
		const link = 'https://aisapira.com/auth/confirm?token_hash=ejemplo&type=invite&next=%2Fdashboard';

		fs.writeFileSync(
			path.join(dir, 'invitacion.html'),
			renderInvitationEmail({ inviterName: 'Domi Zamora', holdingName: 'Hanka', inviteeName: 'Ana Pérez', link }).html
		);
		fs.writeFileSync(
			path.join(dir, 'recuperar-contrasena.html'),
			renderRecoveryEmail({ name: 'Ana Pérez', link: link.replace('type=invite', 'type=recovery') }).html
		);
		expect(fs.existsSync(path.join(dir, 'invitacion.html'))).toBe(true);
	});
});

describe('AuthMailer', () => {
	const realFetch = global.fetch;

	afterEach(() => {
		global.fetch = realFetch;
	});

	it('manda por Resend con remitente por defecto e Idempotency-Key', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ id: 're_1' }) }));

		global.fetch = fetchMock as unknown as typeof fetch;
		const result = await new AuthMailer(config({ RESEND_API_KEY: 'k' })).sendInvitation('ana@x.cl', invitation, 'invite-u-1');

		expect(result).toEqual({ status: 'sent', id: 're_1' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

		expect(url).toBe('https://api.resend.com/emails');
		expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('invite-u-1');
		const body = JSON.parse(String(init.body));

		expect(body).toMatchObject({ from: DEFAULT_AUTH_FROM, to: ['ana@x.cl'] });
		expect(body.text).toBeTruthy();
	});

	it('INVITE_FROM y EMAIL_LOGO_URL mandan sobre los defaults', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ id: 're_2' }) }));

		global.fetch = fetchMock as unknown as typeof fetch;
		await new AuthMailer(
			config({ RESEND_API_KEY: 'k', INVITE_FROM: 'QA <qa@aisapira.com>', EMAIL_LOGO_URL: 'https://qa.x/logo.png' })
		).sendRecovery('a@x.cl', { name: null, link: 'https://x' }, 'k1');
		const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

		expect(body.from).toBe('QA <qa@aisapira.com>');
		expect(body.html).toContain('src="https://qa.x/logo.png"');
	});

	it('nunca lanza: sin clave, con error HTTP o de red → failed', async () => {
		expect(await new AuthMailer(config({})).sendInvitation('a@x.cl', invitation, 'k')).toMatchObject({ status: 'failed' });
		global.fetch = jest.fn(async () => ({ ok: false, status: 422, json: async () => ({ message: 'invalid' }) })) as unknown as typeof fetch;
		expect(await new AuthMailer(config({ RESEND_API_KEY: 'k' })).sendInvitation('a@x.cl', invitation, 'k')).toEqual({
			status: 'failed',
			error: 'invalid',
		});
		global.fetch = jest.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
		expect(await new AuthMailer(config({ RESEND_API_KEY: 'k' })).sendInvitation('a@x.cl', invitation, 'k')).toEqual({
			status: 'failed',
			error: 'offline',
		});
	});

	it('INVITE_TEST_ALLOWLIST: dominios o correos; sin variable no limita', () => {
		expect(isAllowedRecipient('Ana@AISapira.com', 'aisapira.com, qa@cliente.cl')).toBe(true);
		expect(isAllowedRecipient('qa@cliente.cl', 'aisapira.com, qa@cliente.cl')).toBe(true);
		expect(isAllowedRecipient('otro@cliente.cl', 'aisapira.com, qa@cliente.cl')).toBe(false);
		expect(isAllowedRecipient('x@sub.aisapira.com', '@aisapira.com')).toBe(false);
		expect(() => new AuthMailer(config({ INVITE_TEST_ALLOWLIST: 'aisapira.com' })).assertAllowedRecipient('a@otro.cl')).toThrow(
			BadRequestException
		);
		expect(() => new AuthMailer(config({})).assertAllowedRecipient('a@otro.cl')).not.toThrow();
	});

	it('authConfirmUrl arma el enlace del front (o null sin la variable)', () => {
		expect(authConfirmUrl('https://aisapira.com/', 'recovery', '/bienvenida?modo=recuperar', 'h1')).toBe(
			'https://aisapira.com/auth/confirm?token_hash=h1&type=recovery&next=%2Fbienvenida%3Fmodo%3Drecuperar'
		);
		expect(authConfirmUrl(undefined, 'invite', '/dashboard')).toBeNull();
	});
});

describe('PasswordRecoveryService', () => {
	const build = (rows: Record<string, unknown>[], env: Record<string, string> = { INVITE_LANDING_URL: 'https://aisapira.com' }) => {
		const hits = new Map<string, number>();
		const storage = {
			increment: jest.fn(async (key: string) => {
				hits.set(key, (hits.get(key) ?? 0) + 1);

				return { totalHits: hits.get(key), timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
			}),
		};
		const db = { query: jest.fn(async () => rows) };
		const admin = { generateLink: jest.fn(async () => ({ type: 'recovery', hashedToken: 'hash-123', authUserId: 'auth-1' })) };
		const mailer = { sendRecovery: jest.fn<Promise<unknown>, unknown[]>(async () => ({ status: 'sent', id: 're_1' }) as unknown) };
		const service = new PasswordRecoveryService(
			db as unknown as DataSource,
			admin as unknown as SupabaseAdminService,
			mailer as unknown as AuthMailer,
			config(env),
			storage as unknown as ThrottlerStorage
		);

		return { db, admin, mailer, service };
	};

	it('cuenta existente no Inactiva: enlace recovery y correo con la plantilla', async () => {
		const { db, admin, mailer, service } = build([{ id: 'u1', name: 'Ana', auth_id: 'auth-1' }]);

		await expect(service.process('ana@x.cl')).resolves.toBe('sent');
		expect(String((db.query.mock.calls[0] as unknown[])[0])).toContain(`<> 'Inactivo'`);
		expect(admin.generateLink).toHaveBeenCalledWith({
			type: 'recovery',
			email: 'ana@x.cl',
			fullName: null,
			redirectTo: 'https://aisapira.com/auth/confirm?type=recovery&next=%2Fbienvenida%3Fmodo%3Drecuperar',
		});
		const [to, values] = mailer.sendRecovery.mock.calls[0] as [string, { link: string; name: string }];

		expect(to).toBe('ana@x.cl');
		expect(values).toEqual({
			name: 'Ana',
			link: 'https://aisapira.com/auth/confirm?token_hash=hash-123&type=recovery&next=%2Fbienvenida%3Fmodo%3Drecuperar',
		});
	});

	it('sin cuenta (o Inactiva): no genera enlace ni manda correo', async () => {
		const { admin, mailer, service } = build([]);

		await expect(service.process('nadie@x.cl')).resolves.toBe('skipped_no_account');
		expect(admin.generateLink).not.toHaveBeenCalled();
		expect(mailer.sendRecovery).not.toHaveBeenCalled();
	});

	it('cooldown por correo: el segundo pedido en un minuto se omite en silencio', async () => {
		const { mailer, service } = build([{ id: 'u1', name: 'Ana', auth_id: 'auth-1' }]);

		await service.process('ana@x.cl');
		await expect(service.process('ana@x.cl')).resolves.toBe('skipped_cooldown');
		expect(mailer.sendRecovery).toHaveBeenCalledTimes(1);
	});

	it('request responde siempre el mismo mensaje, aunque el trabajo falle', async () => {
		const { admin, service } = build([{ id: 'u1', name: 'Ana', auth_id: 'auth-1' }]);

		admin.generateLink.mockRejectedValueOnce(new Error('down'));
		expect(service.request('ana@x.cl')).toEqual({ message: RECOVERY_MESSAGE });
		expect(build([]).service.request('nadie@x.cl')).toEqual({ message: RECOVERY_MESSAGE });
		await new Promise((resolve) => setImmediate(resolve));
	});
});

describe('Rate limit por actor', () => {
	const token = (payload: object) => `Bearer h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

	it('usa el sub del JWT; sin token, la IP', () => {
		expect(jwtSubject(token({ sub: 'auth-1' }))).toBe('auth-1');
		expect(actorTracker({ headers: { authorization: token({ sub: 'auth-1' }) }, ip: '1.1.1.1' })).toBe('actor:auth-1');
		expect(actorTracker({ headers: {}, ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
		expect(actorTracker({ headers: { authorization: 'Bearer basura' }, ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
	});

	it('recuperar contraseña: primera IP de X-Forwarded-For (la BFF la envía); sin header, la del socket; 10/min', () => {
		expect(forwardedIpTracker({ headers: { 'x-forwarded-for': '200.1.1.1, 10.0.0.2' }, socket: { remoteAddress: '10.0.0.2' } })).toBe(
			'ip:200.1.1.1'
		);
		expect(forwardedIpTracker({ headers: { 'x-forwarded-for': ['201.2.2.2'] }, socket: { remoteAddress: '10.0.0.2' } })).toBe('ip:201.2.2.2');
		expect(forwardedIpTracker({ headers: {}, socket: { remoteAddress: '10.0.0.2' } })).toBe('ip:10.0.0.2');
		expect(RECOVERY_THROTTLE.short).toMatchObject({ limit: 10, ttl: 60_000 });
	});
});

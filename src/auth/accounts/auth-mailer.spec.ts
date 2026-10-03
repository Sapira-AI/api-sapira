import * as fs from 'fs';
import * as path from 'path';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { roleCapabilities } from '@/modules/settings/permissions-catalog';

import { actorTracker, forwardedIpTracker, jwtSubject, RECOVERY_THROTTLE } from './actor-throttle';
import { authConfirmUrl, authLoginUrl, AuthMailer, DEFAULT_AUTH_FROM, isAllowedRecipient } from './auth-mailer';
import { renderInvitationEmail } from './email-templates/invitation';
import { BRAND_FONT_URL, DEFAULT_ASSET_BASE_URL, DEFAULT_LOGO_URL } from './email-templates/layout';
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
/** Rol de ejemplo con permisos reales del catálogo (incluye uno heredado, que se omite). */
const FINANZAS = [
	'VIEW_DASHBOARD',
	'VIEW_CLIENTES',
	'VIEW_CONTRATOS',
	'EDIT_CONTRATOS',
	'VIEW_FACTURACION',
	'EDIT_FACTURACION',
	'VIEW_REVENUE',
	'EDIT_REVENUE',
	'VIEW_CONFIGURACION',
	'CLOSE_PERIODS',
	'MANAGE_INVOICES',
];

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

	it('variantes A (default, hero oscuro con VML para Outlook) y B (banda clara); assets desde la base configurable', () => {
		const a = renderInvitationEmail(invitation);
		const b = renderInvitationEmail(invitation, { variant: 'b' });
		const local = renderRecoveryEmail({ name: null, link: 'https://x' }, { variant: 'b', assetBaseUrl: 'file:///tmp/email/' });

		expect(renderInvitationEmail(invitation, { variant: 'a' }).html).toBe(a.html);
		expect(a.html).toContain(`${DEFAULT_ASSET_BASE_URL}/hero-oscuro.jpg`);
		expect(a.html).toContain('bgcolor="#140047"'); // respaldo sólido del hero (Outlook / sin imágenes) = tono base
		expect(a.html).toContain('bgcolor="#FFA7FF"'); // botón lila de las piezas con texto #140047 (AA)
		expect(a.html).toContain('<v:fill type="frame"');
		expect(b.html).toContain(`src="${DEFAULT_ASSET_BASE_URL}/hero-claro.png"`);
		expect(b.html).not.toContain('hero-oscuro');
		expect(local.html).toContain('src="file:///tmp/email/hero-claro.png"');
		expect(local.html).not.toContain(DEFAULT_ASSET_BASE_URL);
	});

	it('invitación con rol: "Tu rol: …", bajada, capacidades reales con el mismo check, cierre y sin la tarjeta "Quién te invitó"', () => {
		const { html } = renderInvitationEmail({ ...invitation, roleName: 'Finanzas', capabilities: roleCapabilities(FINANZAS) });

		expect(html).not.toContain('Quién te invitó');
		expect(html).not.toContain('Qué puedes hacer en Sapira');
		expect(html).toContain('Domi &lt;script&gt; te invitó a trabajar en Hanka &amp; &quot;Co&quot; en Sapira.');
		expect(html).toContain('Tu rol: Finanzas');
		expect(html).toContain('Ver y editar Contratos');
		expect(html).toContain('Ver Clientes');
		expect(html).toContain('Cerrar y reabrir períodos contables');
		expect(html).toContain('Esto es lo que puedes hacer con tu rol:');
		expect(html.match(new RegExp(`src="${DEFAULT_ASSET_BASE_URL}/check.png"`, 'g'))).toHaveLength(7); // mismo check en cada capacidad
		expect(html).not.toContain('icono-');
		expect(html).toContain('¿Necesitas ver o hacer algo más? Pide a tu administrador en Sapira que actualice tu rol.');
		expect(html).toContain('¿El botón no funciona? Copia este enlace en tu navegador:');
		expect(html).toContain('Si no esperabas este correo, ignóralo.');
		expect(html.match(/<img [^>]*>/g)?.every((img) => / alt="[^"]*"/.test(img))).toBe(true);
	});

	it('rol con todos los permisos (o ALL_PERMISSIONS): una sola línea de acceso completo; sin rol, sin bloque', () => {
		const admin = renderInvitationEmail({ ...invitation, roleName: 'Administrador', capabilities: roleCapabilities(['ALL_PERMISSIONS']) });

		expect(admin.html).toContain('Tu rol: Administrador');
		expect(admin.html.match(/Acceso completo a todos los módulos/g)).toHaveLength(1);
		expect(admin.html).not.toContain('Ver y editar');
		expect(admin.text).toContain(
			'Tu rol: Administrador\nEsto es lo que puedes hacer con tu rol:\n- Acceso completo a todos los módulos\n¿Necesitas ver o hacer algo más?'
		);
		expect(renderInvitationEmail(invitation).html).not.toContain('Tu rol:');
		expect(renderInvitationEmail({ ...invitation, roleName: 'Vacío', capabilities: [] }).html).not.toContain('Tu rol:');
	});

	it('acceso alternativo: línea con Google/Microsoft y "Ir al inicio de sesión" (escapado, también en texto plano); sin URL, sin línea', () => {
		const loginUrl = authLoginUrl('https://aisapira.com/', 'ana+qa"x"@cliente.cl') as string;
		const invite = renderInvitationEmail({ ...invitation, loginUrl });
		const recovery = renderRecoveryEmail({ name: 'Ana', link: 'https://x', loginUrl: 'https://x.cl/login?email=a&b="c"' });

		expect(loginUrl).toBe('https://aisapira.com/login?email=ana%2Bqa%22x%22%40cliente.cl');
		expect(authLoginUrl(undefined, 'a@x.cl')).toBeNull();
		expect(invite.html).toContain('También puedes entrar con tu cuenta de Google o Microsoft si es la de este correo.');
		expect(invite.html).toContain(`<a href="${loginUrl}" target="_blank"`);
		expect(invite.html).toContain('Ir al inicio de sesión</a>');
		expect(invite.text).toContain(`Ir al inicio de sesión: ${loginUrl}`);
		expect(recovery.html).toContain('Si usas Google o Microsoft, entra directamente desde el inicio de sesión.');
		expect(recovery.html).toContain('href="https://x.cl/login?email=a&amp;b=&quot;c&quot;"');
		expect(recovery.text).toContain('Ir al inicio de sesión: https://x.cl/login?email=a&b="c"');
		expect(renderInvitationEmail(invitation).html).not.toContain('Ir al inicio de sesión');
		expect(renderRecoveryEmail({ name: null, link: 'https://x' }).text).not.toContain('Ir al inicio de sesión');
	});

	it('compatible con clientes de correo: sin SVG ni CSS externo propio (solo la fuente de marca), preheader oculto, 600 px', () => {
		for (const variant of ['a', 'b'] as const) {
			for (const { html } of [
				renderInvitationEmail(invitation, { variant }),
				renderRecoveryEmail({ name: 'Ana', link: 'https://x' }, { variant }),
			]) {
				expect(html).not.toMatch(/<svg/i);
				// único <style>: respaldo Arial dentro del condicional de Outlook; único <link>: Plus Jakarta Sans de Google Fonts
				expect(html.replace(/<!--\[if mso\]><style>[^<]*<\/style><!\[endif\]-->/, '')).not.toMatch(/<style/i);
				expect(html.match(/<link [^>]*>/gi)).toEqual([`<link href="${BRAND_FONT_URL}" rel="stylesheet">`]);
				expect(BRAND_FONT_URL.startsWith('https://fonts.googleapis.com/')).toBe(true);
				expect(html).not.toMatch(/<script/i);
				expect(html).not.toMatch(/@import|@font-face/);
				expect(html).toContain('display:none;max-height:0');
				expect(html).toContain('width="600"');
				expect(html).toContain("font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif");
			}
		}
	});

	it('escapa todo valor variable en cada bloque (hero, saludo, rol, capacidades, enlace); el texto plano lo lleva tal cual', () => {
		const evil = {
			inviterName: '<img src=x onerror=alert(1)>',
			holdingName: "O'Brien <b>",
			inviteeName: '"><script>x</script>',
			link: 'https://x.cl/?a=1&b="2"',
			roleName: '<i>Jefa</i> & "Co"',
			capabilities: [{ text: 'Ver <u>todo</u>' }],
		};

		for (const variant of ['a', 'b'] as const) {
			const { html, text } = renderInvitationEmail(evil, { variant });

			expect(html).not.toContain('<img src=x');
			expect(html).not.toContain('<script>');
			expect(html).not.toContain('<b>');
			expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
			expect(html).toContain('O&#39;Brien &lt;b&gt;');
			expect(html).not.toContain('<i>');
			expect(html).not.toContain('<u>');
			expect(html).toContain('Tu rol: &lt;i&gt;Jefa&lt;/i&gt; &amp; &quot;Co&quot;');
			expect(html).toContain('Ver &lt;u&gt;todo&lt;/u&gt;');
			expect(html).toContain('href="https://x.cl/?a=1&amp;b=&quot;2&quot;"');
			expect(text).toContain("<img src=x onerror=alert(1)> te invitó a trabajar en O'Brien <b> en Sapira.");
			expect(text).toContain('Tu rol: <i>Jefa</i> & "Co"\nEsto es lo que puedes hacer con tu rol:\n- Ver <u>todo</u>');
			expect(text).toContain('Aceptar invitación: https://x.cl/?a=1&b="2"');
		}
	});

	it('texto plano alternativo: titular, botón con URL, bloques y pie, sin etiquetas HTML', () => {
		const invite = renderInvitationEmail({
			...invitation,
			inviterName: 'Domi',
			holdingName: 'Hanka',
			roleName: 'Finanzas',
			capabilities: roleCapabilities(['VIEW_CONTRATOS', 'EDIT_FACTURACION']),
		}).text;
		const recovery = renderRecoveryEmail({ name: 'Ana', link: 'https://x.cl/r' }).text;

		expect(invite).toContain('Únete a Hanka en Sapira');
		expect(invite).toContain('Domi te invitó a trabajar en Hanka en Sapira.');
		expect(invite).toContain(
			'Tu rol: Finanzas\nEsto es lo que puedes hacer con tu rol:\n- Ver Contratos\n- Ver y editar Facturación\n¿Necesitas ver o hacer algo más?'
		);
		expect(invite).toContain('El enlace vence en 24 horas.');
		expect(invite).not.toMatch(/<[a-z]/i);
		expect(recovery).toContain('Crear nueva contraseña: https://x.cl/r');
		expect(recovery).toContain('Hola, Ana:');
		expect(recovery).toContain('Si no esperabas este correo, ignóralo.');
		expect(recovery).not.toMatch(/<[a-z]/i);
	});

	it('genera los HTML de ejemplo (SAPIRA_EMAIL_PREVIEW_DIR; assets con SAPIRA_EMAIL_ASSET_BASE; si es file://, también -panel.html en base64)', () => {
		const dir = process.env.SAPIRA_EMAIL_PREVIEW_DIR;

		if (!dir) return;
		fs.mkdirSync(dir, { recursive: true });
		const assetBaseUrl = process.env.SAPIRA_EMAIL_ASSET_BASE || undefined;
		const link = 'https://aisapira.com/auth/confirm?token_hash=ejemplo&type=invite&next=%2Fdashboard';
		const loginUrl = authLoginUrl('https://aisapira.com', 'ana.perez@hanka.cl') as string;
		const base = { inviterName: 'Domi Zamora', holdingName: 'Hanka', inviteeName: 'Ana Pérez', link, loginUrl };
		/** Versión con las imágenes incrustadas (data URI) para verla en el panel lateral, que no carga archivos locales. */
		const inline = (html: string) =>
			html.replace(/file:\/\/[^"')\s]+\.(png|jpg)/g, (url, ext: string) => {
				const data = fs.readFileSync(decodeURIComponent(url.replace('file://', ''))).toString('base64');

				return `data:image/${ext === 'jpg' ? 'jpeg' : 'png'};base64,${data}`;
			});
		const write = (name: string, html: string) => {
			fs.writeFileSync(path.join(dir, `${name}.html`), html);
			if (assetBaseUrl?.startsWith('file://')) fs.writeFileSync(path.join(dir, `${name}-panel.html`), inline(html));
		};

		for (const variant of ['a', 'b'] as const) {
			const options = { variant, assetBaseUrl };

			write(
				`invitacion-${variant}`,
				renderInvitationEmail({ ...base, roleName: 'Finanzas', capabilities: roleCapabilities(FINANZAS) }, options).html
			);
			write(
				`invitacion-admin-${variant}`,
				renderInvitationEmail({ ...base, roleName: 'Administrador', capabilities: roleCapabilities(['ALL_PERMISSIONS']) }, options).html
			);
			write(
				`recuperar-${variant}`,
				renderRecoveryEmail({ name: 'Ana Pérez', link: link.replace('type=invite', 'type=recovery'), loginUrl }, options).html
			);
		}
		expect(fs.existsSync(path.join(dir, 'invitacion-a.html'))).toBe(true);
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
		expect(body.html).not.toContain('Ir al inicio de sesión'); // sin INVITE_LANDING_URL
		await new AuthMailer(config({ RESEND_API_KEY: 'k', INVITE_LANDING_URL: 'https://aisapira.com' })).sendRecovery(
			'ana@x.cl',
			{ name: null, link: 'https://x' },
			'k2'
		);
		expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).text).toContain(
			'Ir al inicio de sesión: https://aisapira.com/login?email=ana%40x.cl'
		);
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

	it('sendRendered (Notificaciones): respeta INVITE_TEST_ALLOWLIST y appUrl arma la URL del front', async () => {
		const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ id: 're_3' }) }));

		global.fetch = fetchMock as unknown as typeof fetch;
		const mailer = new AuthMailer(
			config({ RESEND_API_KEY: 'k', INVITE_TEST_ALLOWLIST: 'aisapira.com', INVITE_LANDING_URL: 'https://qa.aisapira.com/' })
		);
		const email = { subject: 'Hola', html: '<p>x</p>', text: 'x' };

		expect(await mailer.sendRendered('cliente@otra.cl', email, 'k1')).toMatchObject({ status: 'failed' });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await mailer.sendRendered('domi@aisapira.com', email, 'k2')).toEqual({ status: 'sent', id: 're_3' });
		expect(mailer.appUrl('/lab/notificaciones')).toBe('https://qa.aisapira.com/lab/notificaciones');
		expect(new AuthMailer(config({})).appUrl('/x')).toBeNull();
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

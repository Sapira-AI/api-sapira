import { BadGatewayException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AuthMailer } from '@/auth/accounts/auth-mailer';
import { AuthAdminError, SupabaseAdminService } from '@/auth/accounts/supabase-admin.service';
import type { PermissionContext } from '@/guards/permissions.service';

import { fakeDb, Handler } from './fake-db.testing-spec';
import { hasReferences, OWNED_USER_TABLES, SettingsUserAccessService } from './settings-user-access.service';

/**
 * Acciones de acceso de Usuarios (contrato §10) con base falsa y Supabase Auth / Resend **mockeados** (nunca se llaman de verdad).
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const ROLE = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW_ID = 'cccccccc-0000-4000-8000-000000000001';
const TARGET = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTH = 'dddddddd-0000-4000-8000-000000000001';

const actor: PermissionContext = {
	userId: 'me',
	name: 'Domi',
	email: 'domi@x.cl',
	isSuperAdmin: false,
	roleId: ROLE,
	codes: new Set(['ALL_PERMISSIONS']),
};

const member = (extra: Record<string, unknown> = {}) => ({
	id: TARGET,
	name: 'Ana',
	email: 'ana@cliente.cl',
	status: 'Pendiente',
	last_access: null,
	last_invitation_sent_at: null,
	last_invitation_status: null,
	auth_id: AUTH,
	is_super_admin: false,
	access_active: true,
	role_id: ROLE,
	role_name: 'Finanzas',
	holdings_count: 1,
	...extra,
});

const env = (values: Record<string, string | undefined> = {}) =>
	({ get: (key: string) => ({ INVITE_LANDING_URL: 'https://aisapira.com/', ...values })[key] }) as unknown as ConfigService;

function build(handlers: Handler[], config = env()) {
	const db = fakeDb(handlers);
	const admin = {
		assertConfigured: jest.fn(),
		generateLink: jest.fn(async (params: { type: 'invite' | 'magiclink' }) => ({ type: params.type, hashedToken: 'hash<1>', authUserId: AUTH })),
		setBanned: jest.fn(async () => undefined),
		deleteUser: jest.fn(async () => undefined),
	};
	const mailer = {
		assertAllowedRecipient: jest.fn(),
		sendInvitation: jest.fn<Promise<unknown>, unknown[]>(async () => ({ status: 'sent' as const, id: 're_1' }) as unknown),
	};
	const service = new SettingsUserAccessService(
		db as unknown as DataSource,
		admin as unknown as SupabaseAdminService,
		mailer as unknown as AuthMailer,
		config
	);

	return { db, admin, mailer, service };
}

const roleOk: Handler = ['SELECT id FROM roles WHERE id = $1 AND holding_id = $2', () => [{ id: ROLE }]];
const holdingName: Handler = ['SELECT name FROM company_holdings', () => [{ name: 'Hanka <Demo>' }]];
const inviterRow: Handler = ['SELECT name, email FROM users WHERE id = $1', () => [{ name: 'Domi', email: 'domi@x.cl' }]];
const memberRow = (row: Record<string, unknown> | null): Handler => ['WHERE uh.holding_id = $1 AND u.id = $2', () => (row ? [row] : [])];
const admins = (count: number): Handler[] => [
	[
		'WHERE uh.holding_id = $1 AND uh.is_active = true AND COALESCE',
		() => [...Array.from({ length: count }, (_, i) => ({ id: `admin-${i}`, role_id: ROLE })), { id: TARGET, role_id: ROLE }],
	],
	['FROM roles r LEFT JOIN role_permissions rp', () => [{ id: ROLE, codes: ['ALL_PERMISSIONS'] }]],
];

describe('SettingsUserAccessService · invitar', () => {
	const base = (extra: Handler[] = []): Handler[] => [
		...extra,
		roleOk,
		['FROM users u WHERE lower(u.email) = $1', () => []],
		['INSERT INTO users', () => [{ id: NEW_ID }]],
		holdingName,
		inviterRow,
		memberRow(member({ id: NEW_ID, email: 'ana@cliente.cl', last_invitation_sent_at: '2026-10-03T12:00:00Z', last_invitation_status: 'sent' })),
	];

	it('crea Pendiente + membresía en una transacción, genera el enlace invite, guarda auth_id, manda el correo y audita', async () => {
		const { db, admin, mailer, service } = build(base());
		const result = await service.invite(HOLDING, { email: '  Ana@Cliente.CL ', name: ' Ana ', role_id: ROLE }, actor);

		expect(mailer.assertAllowedRecipient).toHaveBeenCalledWith('ana@cliente.cl');
		expect(db.statements('INSERT INTO users')[0].params).toEqual(['ana@cliente.cl', 'Ana', ROLE]);
		expect(db.statements('INSERT INTO user_holdings')[0].params).toEqual([NEW_ID, HOLDING]);
		expect(db.committed()).toBe(1);
		expect(admin.generateLink).toHaveBeenCalledWith({
			type: 'invite',
			email: 'ana@cliente.cl',
			fullName: 'Ana',
			redirectTo: 'https://aisapira.com/auth/confirm?type=invite&next=%2Fdashboard',
		});
		expect(db.statements('UPDATE users SET auth_id')[0].params).toEqual([NEW_ID, AUTH]);
		const [to, values, key] = mailer.sendInvitation.mock.calls[0] as unknown as [string, Record<string, string>, string];

		expect(to).toBe('ana@cliente.cl');
		expect(values).toMatchObject({ inviterName: 'Domi', holdingName: 'Hanka <Demo>', inviteeName: 'Ana' });
		expect(values.link).toBe('https://aisapira.com/auth/confirm?token_hash=hash%3C1%3E&type=invite&next=%2Fdashboard');
		expect(key).toBe(`invite-${NEW_ID}-1`);
		expect(db.statements('UPDATE users SET last_invitation_status')[0].params).toEqual([NEW_ID, 'sent', 're_1']);
		const event = db.statements('INSERT INTO user_access_events')[0];

		expect(event.params.slice(0, 4)).toEqual([HOLDING, NEW_ID, 'me', 'invited']);
		expect(JSON.parse(String(event.params[4]))).toMatchObject({ email: 'ana@cliente.cl', link_type: 'invite', mail_status: 'sent' });
		expect(result.invitation).toEqual({ status: 'sent', sent_at: '2026-10-03T12:00:00Z' });
		expect(result.user).toMatchObject({ id: NEW_ID, ever_signed_in: false, invitation_status: 'sent' });
		expect(result).not.toHaveProperty('message');
	});

	it('si el correo falla: 201 con failed y el mensaje de Reenviar (la invitación queda)', async () => {
		const { db, mailer, service } = build(base());

		mailer.sendInvitation.mockResolvedValueOnce({ status: 'failed', error: 'boom' } as never);
		const result = await service.invite(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ROLE }, actor);

		expect(result.invitation).toEqual({ status: 'failed', sent_at: null });
		expect(result).toHaveProperty('message', 'La invitación quedó creada pero el correo no salió: usa Reenviar');
		expect(db.statements('DELETE FROM users')).toHaveLength(0);
		expect(db.statements('UPDATE users SET last_invitation_status')[0].params).toEqual([NEW_ID, 'failed', null]);
	});

	it('si Auth falla: deshace el alta y responde 502', async () => {
		const { db, admin, mailer, service } = build(base());

		admin.generateLink.mockRejectedValueOnce(new AuthAdminError('down'));
		await expect(service.invite(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ROLE }, actor)).rejects.toBeInstanceOf(
			BadGatewayException
		);
		expect(db.statements('DELETE FROM users WHERE id = $1')[0].params).toEqual([NEW_ID]);
		expect(mailer.sendInvitation).not.toHaveBeenCalled();
		expect(db.statements('INSERT INTO user_access_events')).toHaveLength(0);
	});

	it('si guardar auth_id falla tras crear la cuenta: deshace la fila y la cuenta nueva', async () => {
		const { admin, service } = build([['UPDATE users SET auth_id', () => Promise.reject(new Error('db down'))], ...base()]);

		await expect(service.invite(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ROLE }, actor)).rejects.toThrow('db down');
		expect(admin.deleteUser).toHaveBeenCalledWith(AUTH);
	});

	it('rol de otro holding → 404 sin escribir', async () => {
		const { db, service } = build([['SELECT id FROM roles', () => []]]);

		await expect(service.invite(HOLDING, { email: 'a@b.cl', name: 'A', role_id: ROLE }, actor)).rejects.toBeInstanceOf(NotFoundException);
		expect(db.statements('INSERT')).toHaveLength(0);
	});

	it.each([
		[{ is_super_admin: true, member_active: null }, 'No se puede invitar a este correo'],
		[{ is_super_admin: false, member_active: true }, 'Ya tiene acceso a este holding'],
		[{ is_super_admin: false, member_active: false }, 'Está desactivado: reactívalo'],
		[{ is_super_admin: false, member_active: null }, 'Esta persona ya usa Sapira en otra empresa: escríbenos a soporte'],
	])('correo existente %o → 409 "%s"', async (existing, message) => {
		const { db, service } = build([roleOk, ['FROM users u WHERE lower(u.email) = $1', () => [{ id: TARGET, ...existing }]]]);

		await expect(service.invite(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ROLE }, actor)).rejects.toThrow(
			new ConflictException(message)
		);
		expect(db.statements('INSERT')).toHaveLength(0);
	});

	it('sin INVITE_LANDING_URL → 503 antes de escribir', async () => {
		const { db, service } = build(base(), env({ INVITE_LANDING_URL: '' }));

		await expect(service.invite(HOLDING, { email: 'ana@cliente.cl', name: 'Ana', role_id: ROLE }, actor)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(db.statements('INSERT')).toHaveLength(0);
	});

	it('la lista de prueba (allowlist) se valida antes de todo', async () => {
		const { db, mailer, service } = build(base());

		mailer.assertAllowedRecipient.mockImplementationOnce(() => {
			throw new HttpException('fuera', 400);
		});
		await expect(service.invite(HOLDING, { email: 'x@otro.cl', name: 'X', role_id: ROLE }, actor)).rejects.toThrow('fuera');
		expect(db.calls).toHaveLength(0);
	});
});

describe('SettingsUserAccessService · reenviar', () => {
	const history = (recent: boolean, lastDay: number, total = lastDay): Handler => [
		'FROM user_access_events WHERE user_id = $1',
		() => [{ recent, last_day: lastDay, total }],
	];

	it('Pendiente que nunca entró: token magiclink nuevo, correo con clave idempotente n+1 y evento', async () => {
		const { db, admin, mailer, service } = build([
			memberRow(member()),
			history(false, 2, 3),
			holdingName,
			inviterRow,
			['SELECT last_invitation_sent_at FROM users', () => [{ last_invitation_sent_at: '2026-10-03T13:00:00Z' }]],
		]);
		const result = await service.resend(HOLDING, TARGET, actor);

		expect(admin.generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: 'magiclink', email: 'ana@cliente.cl' }));
		expect(db.statements('UPDATE users SET auth_id')).toHaveLength(0);
		expect(mailer.sendInvitation.mock.calls[0][2]).toBe(`invite-${TARGET}-4`);
		expect((mailer.sendInvitation.mock.calls[0][1] as { link: string }).link).toContain('type=magiclink');
		expect(db.statements('INSERT INTO user_access_events')[0].params[3]).toBe('invitation_resent');
		expect(result).toEqual({ status: 'sent', sent_at: '2026-10-03T13:00:00Z' });
	});

	it('< 60 s desde el último envío → 429', async () => {
		const { admin, service } = build([memberRow(member()), history(true, 1)]);

		await expect(service.resend(HOLDING, TARGET, actor)).rejects.toMatchObject({
			status: 429,
			message: 'Espera un minuto antes de reenviar la invitación',
		});
		expect(admin.generateLink).not.toHaveBeenCalled();
	});

	it('5 envíos en 24 h → 429', async () => {
		const { service } = build([memberRow(member()), history(false, 5)]);

		await expect(service.resend(HOLDING, TARGET, actor)).rejects.toMatchObject({ status: 429 });
	});

	it.each([[{ status: 'Activo' }], [{ last_access: '2026-09-01T00:00:00Z' }], [{ status: 'Inactivo' }]])(
		'%o → 409 Ya activó su cuenta',
		async (extra) => {
			const { service } = build([memberRow(member(extra))]);

			await expect(service.resend(HOLDING, TARGET, actor)).rejects.toThrow(new ConflictException('Ya activó su cuenta'));
		}
	);

	it('super admin o no miembro → 404', async () => {
		await expect(build([memberRow(member({ is_super_admin: true }))]).service.resend(HOLDING, TARGET, actor)).rejects.toBeInstanceOf(
			NotFoundException
		);
		await expect(build([memberRow(null)]).service.resend(HOLDING, TARGET, actor)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('Auth falla → 502', async () => {
		const { admin, service } = build([memberRow(member()), history(false, 0)]);

		admin.generateLink.mockRejectedValueOnce(new AuthAdminError('down'));
		await expect(service.resend(HOLDING, TARGET, actor)).rejects.toBeInstanceOf(BadGatewayException);
	});
});

describe('SettingsUserAccessService · acceso', () => {
	const others = (n: number): Handler => ['holding_id <> $2 AND is_active = true', () => [{ n }]];

	it('desactivar su última membresía: ban en Auth, is_active/selected false, status Inactivo y evento', async () => {
		const { db, admin, service } = build([...admins(1), others(0), memberRow(member({ status: 'Activo', last_access: '2026-09-01' }))]);

		await service.setAccess(HOLDING, TARGET, false, actor);
		expect(admin.setBanned).toHaveBeenCalledWith(AUTH, true);
		expect(db.statements('UPDATE user_holdings SET is_active = false, selected = false')[0].params).toEqual([TARGET, HOLDING]);
		expect(db.statements(`UPDATE users SET status = 'Inactivo'`)).toHaveLength(1);
		expect(db.statements('INSERT INTO user_access_events')[0].params[3]).toBe('deactivated');
	});

	it('desactivar con otros holdings activos: solo la membresía, sin ban ni Inactivo', async () => {
		const { db, admin, service } = build([...admins(1), others(1), memberRow(member({ status: 'Activo' }))]);

		await service.setAccess(HOLDING, TARGET, false, actor);
		expect(admin.setBanned).not.toHaveBeenCalled();
		expect(db.statements(`UPDATE users SET status = 'Inactivo'`)).toHaveLength(0);
	});

	it('si el ban falla → 502 sin tocar la base', async () => {
		const { db, admin, service } = build([...admins(1), others(0), memberRow(member({ status: 'Activo' }))]);

		admin.setBanned.mockRejectedValueOnce(new AuthAdminError('down'));
		await expect(service.setAccess(HOLDING, TARGET, false, actor)).rejects.toBeInstanceOf(BadGatewayException);
		expect(db.statements('UPDATE user_holdings')).toHaveLength(0);
	});

	it('si la base falla tras el ban: lo deshace', async () => {
		const { admin, service } = build([
			['UPDATE user_holdings SET is_active = false', () => Promise.reject(new Error('db down'))],
			...admins(1),
			others(0),
			memberRow(member({ status: 'Activo' })),
		]);

		await expect(service.setAccess(HOLDING, TARGET, false, actor)).rejects.toThrow('db down');
		expect(admin.setBanned.mock.calls).toEqual([
			[AUTH, true],
			[AUTH, false],
		]);
	});

	it('no puede desactivarse a sí mismo; super admin no se toca', async () => {
		await expect(build([memberRow(member({ id: 'me' }))]).service.setAccess(HOLDING, 'me', false, actor)).rejects.toThrow(
			new ConflictException('No puedes desactivarte')
		);
		await expect(
			build([memberRow(member({ is_super_admin: true }))]).service.setAccess(HOLDING, TARGET, false, { ...actor, isSuperAdmin: true })
		).rejects.toThrow(new ConflictException('El acceso de un super admin no se cambia desde aquí'));
	});

	it('desactivar al último que edita la configuración → 409', async () => {
		const { admin, service } = build([...admins(0), others(0), memberRow(member({ status: 'Activo' }))]);

		await expect(service.setAccess(HOLDING, TARGET, false, actor)).rejects.toThrow(
			new ConflictException('El holding quedaría sin nadie que pueda editar la configuración')
		);
		expect(admin.setBanned).not.toHaveBeenCalled();
	});

	it('reactivar a un Inactivo: desbanea y vuelve a Activo/Pendiente según last_access', async () => {
		const { db, admin, service } = build([others(0), memberRow(member({ status: 'Inactivo', access_active: false }))]);

		await service.setAccess(HOLDING, TARGET, true, actor);
		expect(admin.setBanned).toHaveBeenCalledWith(AUTH, false);
		expect(db.statements('UPDATE user_holdings SET is_active = true')).toHaveLength(1);
		expect(db.statements(`CASE WHEN last_access IS NOT NULL THEN 'Activo' ELSE 'Pendiente' END`)).toHaveLength(1);
		expect(db.statements('INSERT INTO user_access_events')[0].params[3]).toBe('reactivated');
	});

	it('ya en el estado pedido: sin cambios ni evento', async () => {
		const { db, admin, service } = build([memberRow(member({ status: 'Activo' }))]);

		await service.setAccess(HOLDING, TARGET, true, actor);
		expect(admin.setBanned).not.toHaveBeenCalled();
		expect(db.statements('UPDATE')).toHaveLength(0);
		expect(db.statements('INSERT INTO user_access_events')).toHaveLength(0);
	});
});

describe('SettingsUserAccessService · eliminar invitación', () => {
	const fks: Handler = [
		'FROM pg_constraint c',
		() => [
			{ tbl: 'contract_change_log', col: 'changed_by' },
			{ tbl: 'quote_events', col: 'actor_id' },
		],
	];
	const referenced = (value: boolean): Handler => ['AS referenced', () => [{ referenced: value }]];
	const otherHoldings = (n: number): Handler => ['SELECT count(*) AS n FROM user_holdings WHERE user_id = $1 AND holding_id <> $2', () => [{ n }]];

	it('Pendiente sin uso y solo en este holding: evento, borra users y la cuenta de Auth', async () => {
		const { db, admin, service } = build([fks, referenced(false), otherHoldings(0), memberRow(member())]);

		await service.removeInvitation(HOLDING, TARGET, actor);
		const order = db.calls.map((call) => call.sql).filter((sql) => /INSERT INTO user_access_events|DELETE FROM users/.test(sql));

		expect(order[0]).toContain('INSERT INTO user_access_events');
		expect(order[1]).toContain('DELETE FROM users WHERE id = $1');
		expect(admin.deleteUser).toHaveBeenCalledWith(AUTH);
	});

	it('en otros holdings: solo quita la membresía de este', async () => {
		const { db, admin, service } = build([fks, referenced(false), otherHoldings(1), memberRow(member())]);

		await service.removeInvitation(HOLDING, TARGET, actor);
		expect(db.statements('DELETE FROM user_holdings WHERE user_id = $1 AND holding_id = $2')).toHaveLength(1);
		expect(db.statements('DELETE FROM users')).toHaveLength(0);
		expect(admin.deleteUser).not.toHaveBeenCalled();
	});

	it.each([[{ status: 'Activo' }], [{ last_access: '2026-09-01' }], [{ status: 'Inactivo' }], [{ id: 'me' }]])('%o → 409', async (extra) => {
		const { service } = build([memberRow(member(extra))]);

		await expect(service.removeInvitation(HOLDING, String((extra as { id?: string }).id ?? TARGET), actor)).rejects.toThrow(
			new ConflictException('Ya activó su cuenta: desactívala en vez de eliminarla')
		);
	});

	it('con referencias → 409 sin borrar', async () => {
		const { db, service } = build([fks, referenced(true), memberRow(member())]);

		await expect(service.removeInvitation(HOLDING, TARGET, actor)).rejects.toBeInstanceOf(ConflictException);
		expect(db.statements('DELETE')).toHaveLength(0);
	});

	it('hasReferences: arma un EXISTS por FK (sin las tablas propias) y una sola consulta', async () => {
		const db = fakeDb([fks, referenced(false)]);

		await expect(hasReferences(db, TARGET)).resolves.toBe(false);
		expect(db.calls[0].params).toEqual([[...OWNED_USER_TABLES]]);
		expect(db.calls[1].sql).toBe(
			'SELECT (EXISTS (SELECT 1 FROM contract_change_log WHERE changed_by = $1) OR EXISTS (SELECT 1 FROM quote_events WHERE actor_id = $1)) AS referenced'
		);
	});
});

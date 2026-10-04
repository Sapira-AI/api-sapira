import { BadGatewayException, BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';

import { AuthAdminError } from '@/auth/accounts/supabase-admin.service';
import { UserProfileAvatarAndAccountEvents1791050000000 } from '@/databases/postgresql/migrations/1791050000000-UserProfileAvatarAndAccountEvents';

import { AVATAR_MAX_BYTES, AVATAR_PRESET_IDS, USER_AVATARS_BUCKET } from './me.constants';
import { isOwnAvatarPath, MeCaller, MeService } from './me.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_ID = 'auth-1';
const PHOTO = `users/${USER_ID}/33333333-3333-4333-8333-333333333333.png`;
const OLD_PHOTO = `users/${USER_ID}/44444444-4444-4444-8444-444444444444.jpg`;

function setup(options: { user?: Record<string, unknown> | null; hasPassword?: boolean | 'error'; holdings?: Record<string, unknown>[] } = {}) {
	const user =
		options.user === null
			? null
			: {
					id: USER_ID,
					name: 'Domi',
					email: 'domi@x.cl',
					role_id: 'role-1',
					last_access: '2026-10-03T10:00:00.000Z',
					is_super_admin: false,
					avatar_preset: null,
					avatar_path: null,
					...options.user,
				};
	const query = jest.fn(async (sql: string) => {
		if (sql.includes('FROM users WHERE auth_id')) return user ? [user] : [];
		if (sql.includes('FROM user_holdings')) {
			return options.holdings ?? [{ id: 'h1', name: 'Hanka', logo_url: null, selected: true, role_name: 'Administrador' }];
		}
		if (sql.includes('FROM auth.users')) {
			if (options.hasPassword === 'error') throw new Error('permission denied for schema auth');

			return [{ has_password: options.hasPassword ?? true }];
		}

		return [];
	});
	const storage = {
		createUploadUrl: jest.fn(async () => ({ signedUrl: 'https://s/upload?token=t', token: 't' })),
		objectSize: jest.fn(async (): Promise<number | null> => 1000),
		remove: jest.fn(async () => undefined),
	};
	const admin = {
		getUser: jest.fn(async () => ({ id: AUTH_ID, identities: [{ provider: 'google' }] })),
		signOut: jest.fn(async () => undefined),
		verifyPassword: jest.fn(async () => true),
		updatePassword: jest.fn(async () => undefined),
	};
	const config = { get: jest.fn((key: string) => (key === 'SUPABASE_URL' ? 'https://sb.co/' : undefined)) };
	const service = new MeService({ query } as never, storage as never, admin as never, config as never);

	return { service, query, storage, admin };
}

const caller = (overrides: Partial<MeCaller> = {}): MeCaller => ({
	authId: AUTH_ID,
	email: 'domi@x.cl',
	jwt: 'jwt-1',
	authUser: { identities: [{ provider: 'email', last_sign_in_at: '2026-10-01' } as never, { provider: 'google' } as never] },
	...overrides,
});

const sqlOf = (query: jest.Mock, fragment: string) => query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

describe('MeService · perfil', () => {
	it('arma el perfil: iniciales, proveedores ordenados, holdings con rol y presets', async () => {
		const { service, admin } = setup();
		const profile = await service.getProfile(caller());

		expect(profile).toMatchObject({
			id: USER_ID,
			name: 'Domi',
			email: 'domi@x.cl',
			avatar: { kind: 'initials' },
			providers: ['password', 'google'],
			has_password: true,
			last_access_at: '2026-10-03T10:00:00.000Z',
			is_super_admin: false,
			holdings: [{ id: 'h1', name: 'Hanka', logo_url: null, role_name: 'Administrador', selected: true }],
		});
		expect(profile.avatar_presets).toHaveLength(12);
		expect(admin.getUser).not.toHaveBeenCalled();
	});

	it('identidad email sin contraseña no cuenta como "password"; azure sí se informa', async () => {
		const { service } = setup({ hasPassword: false });
		const profile = await service.getProfile(
			caller({ authUser: { identities: [{ provider: 'email' } as never, { provider: 'azure' } as never] } })
		);

		expect(profile.providers).toEqual(['azure']);
		expect(profile.has_password).toBe(false);
	});

	it('sin identidades en la sesión las pide a Auth admin', async () => {
		const { service, admin } = setup({ hasPassword: false });
		const profile = await service.getProfile(caller({ authUser: null }));

		expect(admin.getUser).toHaveBeenCalledWith(AUTH_ID);
		expect(profile.providers).toEqual(['google']);
	});

	it('si no puede leer auth.users, deduce la contraseña de la identidad email con ingreso', async () => {
		const { service } = setup({ hasPassword: 'error' });

		expect((await service.getProfile(caller())).has_password).toBe(true);
	});

	it('foto subida → URL pública del bucket; preset → id; super admin → rol "Super Admin"', async () => {
		const withPhoto = await setup({ user: { avatar_path: PHOTO } }).service.getProfile(caller());

		expect(withPhoto.avatar).toEqual({ kind: 'upload', url: `https://sb.co/storage/v1/object/public/${USER_AVATARS_BUCKET}/${PHOTO}` });
		const withPreset = await setup({ user: { avatar_preset: 'preset-04', is_super_admin: true } }).service.getProfile(caller());

		expect(withPreset.avatar).toEqual({ kind: 'preset', preset_id: 'preset-04' });
		expect(withPreset.holdings[0].role_name).toBe('Super Admin');
	});

	it('el rol se busca solo en el holding al que pertenece (join con roles.holding_id)', async () => {
		const { service, query } = setup();

		await service.getProfile(caller());
		const [[sql, params]] = sqlOf(query, 'FROM user_holdings');

		expect(sql).toContain('r.id = $2 AND r.holding_id = uh.holding_id');
		expect(sql).toContain('uh.is_active = true');
		expect(params).toEqual([USER_ID, 'role-1']);
	});

	it('sin fila en users → 404', async () => {
		await expect(setup({ user: null }).service.getProfile(caller())).rejects.toBeInstanceOf(NotFoundException);
	});
});

describe('MeService · PATCH perfil', () => {
	it('cambia el nombre', async () => {
		const { service, query } = setup();

		await service.updateProfile(caller(), { name: 'Dominique' });
		expect(sqlOf(query, 'UPDATE users')[0]).toEqual(['UPDATE users SET name = $2 WHERE id = $1', [USER_ID, 'Dominique']]);
	});

	it('elegir un preset limpia la foto y borra el objeto anterior', async () => {
		const { service, query, storage } = setup({ user: { avatar_path: OLD_PHOTO } });

		await service.updateProfile(caller(), { avatar: { kind: 'preset', preset_id: 'preset-02' } });
		expect(sqlOf(query, 'UPDATE users')[0]).toEqual([
			'UPDATE users SET avatar_preset = $2, avatar_path = NULL WHERE id = $1',
			[USER_ID, 'preset-02'],
		]);
		expect(storage.remove).toHaveBeenCalledWith(USER_AVATARS_BUCKET, OLD_PHOTO);
	});

	it('iniciales deja ambas columnas en NULL', async () => {
		const { service, query } = setup();

		await service.updateProfile(caller(), { avatar: { kind: 'initials' } });
		expect(sqlOf(query, 'UPDATE users')[0][1]).toEqual([USER_ID, null]);
	});

	it('rechaza upload por PATCH y el body vacío', async () => {
		const { service } = setup();

		await expect(service.updateProfile(caller(), { avatar: { kind: 'upload' } })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.updateProfile(caller(), {})).rejects.toBeInstanceOf(BadRequestException);
	});
});

describe('MeService · foto', () => {
	it('firma la subida en users/<id>/<uuid>.<ext>', async () => {
		const { service, storage } = setup();
		const result = await service.prepareAvatarUpload(caller(), { file_name: 'yo.webp', mime_type: 'image/webp', size: 1000 });

		expect(result.path).toMatch(new RegExp(`^users/${USER_ID}/[0-9a-f-]{36}\\.webp$`));
		expect(result).toMatchObject({ upload_url: 'https://s/upload?token=t', token: 't', max_bytes: AVATAR_MAX_BYTES });
		expect(storage.createUploadUrl).toHaveBeenCalledWith(USER_AVATARS_BUCKET, result.path);
	});

	it('rechaza SVG y más de 2 MB', async () => {
		const { service } = setup();

		await expect(service.prepareAvatarUpload(caller(), { file_name: 'a.svg', mime_type: 'image/svg+xml', size: 10 })).rejects.toThrow(
			'La foto debe ser PNG, JPG o WEBP'
		);
		await expect(
			service.prepareAvatarUpload(caller(), { file_name: 'a.png', mime_type: 'image/png', size: AVATAR_MAX_BYTES + 1 })
		).rejects.toThrow('La foto no puede superar 2 MB');
	});

	it('confirma: guarda la ruta, limpia el preset y borra la foto anterior', async () => {
		const { service, query, storage } = setup({ user: { avatar_path: OLD_PHOTO } });

		await service.confirmAvatar(caller(), { path: PHOTO });
		expect(sqlOf(query, 'UPDATE users')[0]).toEqual(['UPDATE users SET avatar_path = $2, avatar_preset = NULL WHERE id = $1', [USER_ID, PHOTO]]);
		expect(storage.remove).toHaveBeenCalledWith(USER_AVATARS_BUCKET, OLD_PHOTO);
	});

	it('ruta de otra persona o inventada → 400; sin objeto → 409; > 2 MB → se borra y 400', async () => {
		const { service, storage } = setup();

		await expect(service.confirmAvatar(caller(), { path: `users/${OTHER_ID}/33333333-3333-4333-8333-333333333333.png` })).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(service.confirmAvatar(caller(), { path: `users/${USER_ID}/../x.png` })).rejects.toBeInstanceOf(BadRequestException);
		storage.objectSize.mockResolvedValueOnce(null);
		await expect(service.confirmAvatar(caller(), { path: PHOTO })).rejects.toBeInstanceOf(ConflictException);
		storage.objectSize.mockResolvedValueOnce(AVATAR_MAX_BYTES + 1);
		await expect(service.confirmAvatar(caller(), { path: PHOTO })).rejects.toBeInstanceOf(BadRequestException);
		expect(storage.remove).toHaveBeenCalledWith(USER_AVATARS_BUCKET, PHOTO);
	});

	it('isOwnAvatarPath', () => {
		expect(isOwnAvatarPath(PHOTO, USER_ID)).toBe(true);
		expect(isOwnAvatarPath(PHOTO.replace('.png', '.svg'), USER_ID)).toBe(false);
		expect(isOwnAvatarPath(PHOTO, OTHER_ID)).toBe(false);
	});
});

describe('MeService · seguridad de la cuenta', () => {
	it('cierre global: signOut(jwt, global) y evento sessions_revoked sin holding', async () => {
		const { service, admin, query } = setup();

		await expect(service.revokeAllSessions(caller())).resolves.toEqual({ message: 'Cerramos tu sesión en todos los dispositivos' });
		expect(admin.signOut).toHaveBeenCalledWith('jwt-1', 'global');
		const [[sql, params]] = sqlOf(query, 'INSERT INTO user_access_events');

		expect(sql).toContain('VALUES (NULL, $1, $1, $2, $3::jsonb)');
		expect(params).toEqual([USER_ID, 'sessions_revoked', '{}']);
	});

	it('cierre global: falla de Auth → 502 y sin evento; límite → 429', async () => {
		const { service, admin, query } = setup();

		admin.signOut.mockRejectedValueOnce(new AuthAdminError('boom'));
		await expect(service.revokeAllSessions(caller())).rejects.toBeInstanceOf(BadGatewayException);
		admin.signOut.mockRejectedValueOnce(new AuthAdminError('slow down', 'over_request_rate_limit'));
		await expect(service.revokeAllSessions(caller())).rejects.toMatchObject({ status: 429 });
		expect(sqlOf(query, 'INSERT INTO user_access_events')).toHaveLength(0);
	});

	it('cambia la contraseña verificando la actual, cierra las demás sesiones si se pide y audita', async () => {
		const { service, admin, query } = setup();

		await expect(
			service.changePassword(caller(), { current_password: 'vieja123', new_password: 'nueva1234', sign_out_other_sessions: true })
		).resolves.toEqual({ message: 'Contraseña actualizada' });
		expect(admin.verifyPassword).toHaveBeenCalledWith('domi@x.cl', 'vieja123');
		expect(admin.updatePassword).toHaveBeenCalledWith(AUTH_ID, 'nueva1234');
		expect(admin.signOut).toHaveBeenCalledWith('jwt-1', 'others');
		expect(sqlOf(query, 'INSERT INTO user_access_events')[0][1]).toEqual([USER_ID, 'password_changed', '{"signed_out_others":true}']);
	});

	it('contraseña actual incorrecta → 400 en current_password, sin cambiar nada', async () => {
		const { service, admin } = setup();

		admin.verifyPassword.mockResolvedValueOnce(false);
		const error = await service.changePassword(caller(), { current_password: 'mala1234', new_password: 'nueva1234' }).catch((cause) => cause);

		expect(error).toBeInstanceOf(BadRequestException);
		expect((error as HttpException).getResponse()).toMatchObject({
			errors: [{ field: 'current_password', message: 'La contraseña actual no es correcta' }],
		});
		expect(admin.updatePassword).not.toHaveBeenCalled();
	});

	it('cuenta sin contraseña → 409; nueva igual a la actual → 400; Supabase la rechaza por débil → 400', async () => {
		await expect(
			setup({ hasPassword: false }).service.changePassword(caller(), { current_password: 'x', new_password: 'nueva1234' })
		).rejects.toBeInstanceOf(ConflictException);
		const { service, admin } = setup();

		await expect(service.changePassword(caller(), { current_password: 'misma1234', new_password: 'misma1234' })).rejects.toThrow(
			'La contraseña nueva debe ser distinta de la actual'
		);
		admin.updatePassword.mockRejectedValueOnce(new AuthAdminError('Password is known to be weak', 'weak_password'));
		await expect(service.changePassword(caller(), { current_password: 'vieja123', new_password: 'password1' })).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
});

describe('Migración 1791050000000 · Mi perfil', () => {
	const run = async (direction: 'up' | 'down') => {
		const calls: string[] = [];
		const migration = new UserProfileAvatarAndAccountEvents1791050000000();

		await migration[direction]({ query: async (sql: string) => calls.push(sql) } as never);

		return calls.join('\n');
	};

	it('up: columnas de avatar con CHECK, holding_id nullable, acciones nuevas y bucket público con límites', async () => {
		const sql = await run('up');

		expect(sql).toContain('ALTER TABLE "users" ADD "avatar_preset" text');
		expect(sql).toContain('ALTER TABLE "users" ADD "avatar_path" text');
		expect(sql).toContain('CHECK (avatar_preset IS NULL OR avatar_path IS NULL)');
		expect(sql).toContain('ALTER TABLE "user_access_events" ALTER COLUMN "holding_id" DROP NOT NULL');
		expect(sql).toContain("'password_changed'::text, 'sessions_revoked'::text");
		expect(sql).toMatch(/'user-avatars', 'user-avatars', true, 2097152, ARRAY\['image\/png', 'image\/jpeg', 'image\/webp'\]/);
		expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
	});

	it('down: deshace columnas y CHECK sin borrar el bucket', async () => {
		const sql = await run('down');

		expect(sql).toContain('DROP COLUMN IF EXISTS "avatar_path"');
		expect(sql).toContain('ALTER COLUMN "holding_id" SET NOT NULL');
		expect(sql).not.toContain('storage.buckets');
	});

	it('los presets son 12 ids preset-NN', () => {
		expect(AVATAR_PRESET_IDS).toEqual(Array.from({ length: 12 }, (_, i) => `preset-${String(i + 1).padStart(2, '0')}`));
	});
});

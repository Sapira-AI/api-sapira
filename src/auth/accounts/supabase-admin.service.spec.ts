import { createClient } from '@supabase/supabase-js';

import { AuthAdminError, SupabaseAdminService } from './supabase-admin.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

/** Mi perfil: verificar la contraseña con un cliente desechable (y cerrar su sesión), cambiarla, cerrar sesiones y leer la cuenta. */
describe('SupabaseAdminService · Mi perfil', () => {
	const admin = {
		signOut: jest.fn(async () => ({ data: null, error: null as unknown })),
		updateUserById: jest.fn(async () => ({ data: {}, error: null as unknown })),
		getUserById: jest.fn(async () => ({ data: { user: { id: 'auth-1', identities: [] } }, error: null as unknown })),
	};
	const signInWithPassword = jest.fn();
	const env: Record<string, string> = { SUPABASE_URL: 'https://sb.co', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' };
	const config = { get: (key: string) => env[key] };

	beforeEach(() => {
		jest.clearAllMocks();
		(createClient as jest.Mock).mockImplementation((_url: string, key: string) =>
			key === 'service' ? { auth: { admin } } : { auth: { signInWithPassword } }
		);
	});

	const service = () => new SupabaseAdminService(config as never);

	it('verifyPassword: correcta → true y cierra la sesión temporal (cliente anon desechable)', async () => {
		signInWithPassword.mockResolvedValueOnce({ data: { session: { access_token: 'temp' } }, error: null });

		await expect(service().verifyPassword('a@x.cl', 'clave123')).resolves.toBe(true);
		expect(createClient).toHaveBeenCalledWith('https://sb.co', 'anon', expect.anything());
		expect(admin.signOut).toHaveBeenCalledWith('temp', 'local');
	});

	it('verifyPassword: credenciales incorrectas → false; otra falla → AuthAdminError', async () => {
		signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } });
		await expect(service().verifyPassword('a@x.cl', 'mala')).resolves.toBe(false);
		signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Too many', code: 'over_request_rate_limit' } });
		await expect(service().verifyPassword('a@x.cl', 'x')).rejects.toBeInstanceOf(AuthAdminError);
	});

	it('signOut, updatePassword y getUser usan la API admin', async () => {
		const svc = service();

		await svc.signOut('jwt', 'global');
		expect(admin.signOut).toHaveBeenCalledWith('jwt', 'global');
		await svc.updatePassword('auth-1', 'nueva1234');
		expect(admin.updateUserById).toHaveBeenCalledWith('auth-1', { password: 'nueva1234' });
		await expect(svc.getUser('auth-1')).resolves.toEqual({ id: 'auth-1', identities: [] });
		admin.updateUserById.mockResolvedValueOnce({ data: {}, error: { message: 'weak', code: 'weak_password' } });
		await expect(svc.updatePassword('auth-1', 'x')).rejects.toMatchObject({ code: 'weak_password' });
	});
});

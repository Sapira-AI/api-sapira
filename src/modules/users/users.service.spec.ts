import { UsersService } from './users.service';

describe('UsersService menu context', () => {
	it('returns role permission codes from the Sapira catalog, not settings', async () => {
		const userRepository = {
			findOne: jest.fn().mockResolvedValue({
				id: 'user-1',
				name: 'León',
				email: 'leon@example.com',
				role_id: 'role-admin',
				status: 'Activo',
				auth_id: 'auth-1',
				created_at: new Date('2026-01-01'),
				is_super_admin: false,
			}),
			query: jest
				.fn()
				.mockResolvedValueOnce([{ name: 'Administrador' }])
				.mockResolvedValueOnce([{ code: 'VIEW_CONFIGURACION' }, { code: 'EDIT_CONFIGURACION' }]),
		};
		const holdingsService = {
			getUserHoldings: jest.fn().mockResolvedValue([{ id: 'holding-1', name: 'Demo', selected: true, is_active: true }]),
		};

		const service = new UsersService(userRepository as never, holdingsService as never);
		const context = await service.getUserMenuContext('auth-1');

		expect(context.role_name).toBe('Administrador');
		expect(context.permissions).toEqual(['VIEW_CONFIGURACION', 'EDIT_CONFIGURACION']);
		expect(context.permissions).not.toContain('settings');
		expect(userRepository.query).toHaveBeenNthCalledWith(2, expect.stringContaining('role_permissions'), ['role-admin']);
	});
});

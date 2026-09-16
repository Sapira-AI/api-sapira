import { NOTIFICATION_EVENTS, NotificationsGateway } from './notifications.gateway';

const getUser = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
	createClient: jest.fn(() => ({ auth: { getUser } })),
}));

describe('NotificationsGateway', () => {
	const buildGateway = () => {
		const configService = {
			get: jest.fn((key: string) => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-key' })[key]),
		};
		const userRepository = { findOne: jest.fn() };
		const emit = jest.fn();
		const server = { to: jest.fn().mockReturnValue({ emit }) };
		const gateway = new NotificationsGateway(configService as any, userRepository as any);
		gateway.server = server as any;

		return { gateway, userRepository, server, emit };
	};

	const buildClient = (handshake: { auth?: Record<string, unknown>; headers?: Record<string, string> }) => ({
		id: 'socket-1',
		handshake: { auth: handshake.auth || {}, headers: handshake.headers || {} },
		join: jest.fn(),
		emit: jest.fn(),
		disconnect: jest.fn(),
	});

	beforeEach(() => {
		getUser.mockReset();
	});

	describe('handleConnection', () => {
		it('une al cliente a la sala del usuario interno y confirma la conexión', async () => {
			const { gateway, userRepository } = buildGateway();
			getUser.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null });
			userRepository.findOne.mockResolvedValue({ id: 'user-1' });
			const client = buildClient({ auth: { token: 'token-1' } });

			await gateway.handleConnection(client as any);

			expect(getUser).toHaveBeenCalledWith('token-1');
			expect(userRepository.findOne).toHaveBeenCalledWith({ where: { auth_id: 'auth-user-1' } });
			expect(client.join).toHaveBeenCalledWith('user:user-1');
			expect(client.emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.connected, { userId: 'auth-user-1' });
			expect(client.disconnect).not.toHaveBeenCalled();
		});

		it('acepta el token en el header Authorization', async () => {
			const { gateway, userRepository } = buildGateway();
			getUser.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null });
			userRepository.findOne.mockResolvedValue({ id: 'user-1' });
			const client = buildClient({ headers: { authorization: 'Bearer token-header' } });

			await gateway.handleConnection(client as any);

			expect(getUser).toHaveBeenCalledWith('token-header');
			expect(client.join).toHaveBeenCalledWith('user:user-1');
		});

		it.each([
			['sin token', () => undefined, {}],
			[
				'con token inválido',
				() => getUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid') }),
				{ auth: { token: 'bad' } },
			],
		])('emite unauthorized y desconecta %s', async (_label, arrange, handshake) => {
			const { gateway } = buildGateway();
			arrange();
			const client = buildClient(handshake);

			await gateway.handleConnection(client as any);

			expect(client.emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.unauthorized, { message: expect.any(String) });
			expect(client.disconnect).toHaveBeenCalledWith(true);
			expect(client.join).not.toHaveBeenCalled();
		});

		it('emite unauthorized y desconecta si el usuario no existe en Sapira', async () => {
			const { gateway, userRepository } = buildGateway();
			getUser.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null });
			userRepository.findOne.mockResolvedValue(null);
			const client = buildClient({ auth: { token: 'token-1' } });

			await gateway.handleConnection(client as any);

			expect(client.emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.unauthorized, { message: 'Usuario autenticado no encontrado' });
			expect(client.disconnect).toHaveBeenCalledWith(true);
		});
	});

	describe('emisión de eventos', () => {
		it('emite notification:created a cada destinatario con is_read false', () => {
			const { gateway, server, emit } = buildGateway();

			gateway.emitNotificationCreated('holding-1', ['user-1', 'user-2'], { id: 'notification-1', title: 'Falla' } as any);

			expect(server.to).toHaveBeenCalledWith('user:user-1');
			expect(server.to).toHaveBeenCalledWith('user:user-2');
			expect(emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.created, {
				holdingId: 'holding-1',
				notification: { id: 'notification-1', title: 'Falla', is_read: false },
			});
		});

		it('emite notification:read solo a la sala del usuario', () => {
			const { gateway, server, emit } = buildGateway();
			const readAt = new Date('2026-09-16T12:00:00Z');

			gateway.emitNotificationRead('user-1', { holdingId: 'holding-1', notificationId: 'notification-1', read_at: readAt });

			expect(server.to).toHaveBeenCalledTimes(1);
			expect(server.to).toHaveBeenCalledWith('user:user-1');
			expect(emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.read, {
				holdingId: 'holding-1',
				notificationId: 'notification-1',
				read_at: readAt,
			});
		});

		it('emite notification:updated una vez por destinatario, sin duplicados', () => {
			const { gateway, server, emit } = buildGateway();

			gateway.emitNotificationUpdated(['user-1', 'user-1', 'user-2'], { holdingId: 'holding-1', notificationId: 'notification-1' });

			expect(server.to).toHaveBeenCalledTimes(2);
			expect(emit).toHaveBeenCalledWith(NOTIFICATION_EVENTS.updated, { holdingId: 'holding-1', notificationId: 'notification-1' });
		});
	});
});

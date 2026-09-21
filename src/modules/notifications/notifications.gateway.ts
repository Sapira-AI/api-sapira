import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';

import { getCorsOrigins } from '@/core/config/cors-origins';
import { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

export const NOTIFICATION_EVENTS = {
	connected: 'connected',
	unauthorized: 'unauthorized',
	created: 'notification:created',
	read: 'notification:read',
	updated: 'notification:updated',
} as const;

@WebSocketGateway({
	namespace: '/notifications',
	cors: {
		origin: getCorsOrigins(),
		credentials: true,
	},
})
export class NotificationsGateway implements OnGatewayConnection {
	@WebSocketServer()
	server: Server;

	private readonly logger = new Logger(NotificationsGateway.name);
	private readonly supabase: SupabaseClient;

	constructor(
		configService: ConfigService,
		@InjectRepository(User)
		private readonly userRepository: Repository<User>
	) {
		const url = configService.get<string>('SUPABASE_URL');
		const key = configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || configService.get<string>('SUPABASE_ANON_KEY');
		if (!url || !key) {
			throw new Error('SUPABASE_URL y SUPABASE_ANON_KEY (o SUPABASE_SERVICE_ROLE_KEY) son requeridos');
		}

		this.supabase = createClient(url, key, {
			auth: { autoRefreshToken: false, persistSession: false },
		});
	}

	async handleConnection(client: Socket) {
		const token = this.getAccessToken(client);
		if (!token) {
			return this.rejectConnection(client, 'Token de acceso requerido');
		}

		const { data, error } = await this.supabase.auth.getUser(token);
		if (error || !data.user) {
			return this.rejectConnection(client, 'Sesión expirada o inválida');
		}

		const user = await this.userRepository.findOne({ where: { auth_id: data.user.id } });
		if (!user) {
			return this.rejectConnection(client, 'Usuario autenticado no encontrado');
		}

		await client.join(this.userRoom(user.id));
		client.emit(NOTIFICATION_EVENTS.connected, { userId: data.user.id });
		this.logger.debug(`Cliente ${client.id} conectado a notificaciones para usuario ${user.id}`);
	}

	emitNotificationCreated(holdingId: string, recipientUserIds: string[], notification: AppNotification) {
		for (const userId of recipientUserIds) {
			this.server.to(this.userRoom(userId)).emit(NOTIFICATION_EVENTS.created, {
				holdingId,
				notification: {
					...notification,
					is_read: false,
				},
			});
		}
	}

	/** Avisa a las otras pestañas/fronts del mismo usuario que una notificación quedó leída. */
	emitNotificationRead(userId: string, payload: { holdingId: string; notificationId: string; read_at: Date }) {
		this.server.to(this.userRoom(userId)).emit(NOTIFICATION_EVENTS.read, payload);
	}

	/** Avisa a los destinatarios que una notificación abierta cambió de contenido o quedó resuelta. */
	emitNotificationUpdated(recipientUserIds: string[], payload: { holdingId: string; notificationId: string }) {
		for (const userId of new Set(recipientUserIds)) {
			this.server.to(this.userRoom(userId)).emit(NOTIFICATION_EVENTS.updated, payload);
		}
	}

	private rejectConnection(client: Socket, message: string) {
		client.emit(NOTIFICATION_EVENTS.unauthorized, { message });
		client.disconnect(true);
	}

	private getAccessToken(client: Socket) {
		const authToken = client.handshake.auth?.token;
		if (typeof authToken === 'string' && authToken) {
			return authToken;
		}

		const authorization = client.handshake.headers.authorization;
		return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
	}

	private userRoom(userId: string) {
		return `user:${userId}`;
	}
}

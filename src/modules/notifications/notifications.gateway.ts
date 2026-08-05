import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';

import { User } from '@/modules/users/entities/user.entity';

import { AppNotification } from './entities/app-notification.entity';

@WebSocketGateway({
	namespace: '/notifications',
	cors: {
		origin: process.env.FRONT_BASE_URL || 'http://localhost:8080',
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
			return client.disconnect(true);
		}

		const { data, error } = await this.supabase.auth.getUser(token);
		if (error || !data.user) {
			return client.disconnect(true);
		}

		const user = await this.userRepository.findOne({ where: { auth_id: data.user.id } });
		if (!user) {
			return client.disconnect(true);
		}

		await client.join(this.userRoom(user.id));
		client.emit('connected', { userId: data.user.id });
		this.logger.debug(`Cliente ${client.id} conectado a notificaciones para usuario ${user.id}`);
	}

	emitNotificationCreated(holdingId: string, recipientUserIds: string[], notification: AppNotification) {
		for (const userId of recipientUserIds) {
			this.server.to(this.userRoom(userId)).emit('notification:created', {
				holdingId,
				notification: {
					...notification,
					is_read: false,
				},
			});
		}
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

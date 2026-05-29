import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { SchedulerJobProgressDto } from './dtos/scheduler-job.dto';
import { ProcessInvoicesResponseDto } from './dtos/send-invoices.dto';

@WebSocketGateway({
	cors: {
		origin: process.env.FRONT_BASE_URL || 'http://localhost:8080',
		credentials: true,
	},
	namespace: '/scheduler',
})
export class InvoiceSchedulerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
	@WebSocketServer()
	server: Server;

	private readonly logger = new Logger(InvoiceSchedulerGateway.name);

	afterInit(server: Server) {
		this.logger.log('🔌 WebSocket Gateway inicializado para Invoice Scheduler', server);
	}

	handleConnection(client: Socket) {
		const holdingId = client.handshake.query.holdingId as string;
		const userId = client.handshake.query.userId as string;

		this.logger.log(`✅ Cliente conectado: ${client.id} (HoldingId: ${holdingId}, UserId: ${userId})`);

		if (holdingId) {
			client.join(`holding:${holdingId}`);
			this.logger.log(`📁 Cliente ${client.id} unido a sala holding:${holdingId}`);
		}

		if (userId) {
			client.join(`user:${userId}`);
			this.logger.log(`👤 Cliente ${client.id} unido a sala user:${userId}`);
		}
	}

	handleDisconnect(client: Socket) {
		this.logger.log(`❌ Cliente desconectado: ${client.id}`);
	}

	emitJobStarted(jobId: string, holdingId: string, userId: string, dryRun: boolean, total: number) {
		const room = `user:${userId}`;
		this.server.to(room).emit('scheduler:started', {
			jobId,
			holdingId,
			dryRun,
			total,
			timestamp: new Date(),
		});
		this.logger.log(`🚀 Evento scheduler:started emitido para job ${jobId} (room: ${room})`);
	}

	emitJobProgress(jobId: string, holdingId: string, userId: string, progress: SchedulerJobProgressDto) {
		const room = `user:${userId}`;
		this.server.to(room).emit('scheduler:progress', {
			jobId,
			holdingId,
			progress,
			timestamp: new Date(),
		});
	}

	emitJobCompleted(jobId: string, holdingId: string, userId: string, result: ProcessInvoicesResponseDto) {
		const room = `user:${userId}`;
		this.server.to(room).emit('scheduler:completed', {
			jobId,
			holdingId,
			result,
			timestamp: new Date(),
		});
		this.logger.log(`✅ Evento scheduler:completed emitido para job ${jobId} (room: ${room})`);
	}

	emitJobError(jobId: string, holdingId: string, userId: string, error: string) {
		const room = `user:${userId}`;
		this.server.to(room).emit('scheduler:error', {
			jobId,
			holdingId,
			error,
			timestamp: new Date(),
		});
		this.logger.error(`❌ Evento scheduler:error emitido para job ${jobId} (room: ${room}): ${error}`);
	}
}

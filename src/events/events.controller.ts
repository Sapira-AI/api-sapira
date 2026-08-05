import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { v4 as uuid } from 'uuid';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { BaseEvent, EventStatus, EventType } from '@/core/interfaces/events/event.interface';

import { ClientErrorDTO } from './dtos/client-error.dto';
import { EventsService } from './services/events.service';

@ApiExcludeController()
@ApiTags('Events')
@Controller('events')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class EventsController {
	constructor(private readonly eventsService: EventsService) {}

	@Post('client-error')
	async handleClientError(@Body() errorData: ClientErrorDTO, @Req() req: Request): Promise<void> {
		const event: BaseEvent = {
			id: uuid(),
			type: EventType.CLIENT_ERROR,
			timestamp: new Date(),
			correlationId: errorData.correlationId || uuid(),
			severity: errorData.severity,
			status: EventStatus.FAILED,
			userId: errorData.userId,
			metadata: {
				...errorData.metadata,
				url: errorData.url,
				userAgent: errorData.userAgent,
				componentName: errorData.componentName,
				ip: req.ip,
				error: {
					message: errorData.message,
					stack: errorData.stack,
				},
				// Información adicional del navegador
				browserInfo: {
					language: req.headers['accept-language'],
					referer: req.headers.referer,
					host: req.headers.host,
				},
			},
		};

		await this.eventsService.logClientError(event);
	}
}

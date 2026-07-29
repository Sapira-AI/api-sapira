import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { RequestWithUser } from '@/core/interfaces/request-with-user.interface';

import { ListNotificationsDto, ReplaceSalesforceStagingBlockedSubscriptionsDto } from './dtos/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', description: 'ID del holding activo', required: true })
@Controller('notifications')
@UseGuards(SupabaseAuthGuard)
export class NotificationsController {
	constructor(private readonly notificationsService: NotificationsService) {}

	@Get()
	@ApiOperation({ summary: 'Listar las notificaciones del usuario autenticado' })
	async list(
		@Headers('x-holding-id') holdingId: string,
		@Request() request: RequestWithUser,
		@Query() query: ListNotificationsDto
	) {
		return this.notificationsService.listForAuthenticatedUser(holdingId, request.user?.id || request.user?.sub, query);
	}

	@Get('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Listar suscripciones por rol para bloqueos de staging Salesforce' })
	async listSalesforceStagingBlockedSubscriptions(@Headers('x-holding-id') holdingId: string, @Request() request: RequestWithUser) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, request.user?.id || request.user?.sub);
		return this.notificationsService.listSalesforceStagingBlockedSubscriptions(holdingId);
	}

	@Put('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Reemplazar suscripciones por rol para bloqueos de staging Salesforce' })
	async replaceSalesforceStagingBlockedSubscriptions(
		@Headers('x-holding-id') holdingId: string,
		@Request() request: RequestWithUser,
		@Body() dto: ReplaceSalesforceStagingBlockedSubscriptionsDto
	) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, request.user?.id || request.user?.sub);
		return this.notificationsService.replaceSalesforceStagingBlockedSubscriptions(holdingId, dto);
	}

	@Get(':notificationId')
	@ApiOperation({ summary: 'Obtener el detalle de una notificación propia' })
	async getOne(
		@Headers('x-holding-id') holdingId: string,
		@Request() request: RequestWithUser,
		@Param('notificationId') notificationId: string
	) {
		return this.notificationsService.getForAuthenticatedUser(holdingId, request.user?.id || request.user?.sub, notificationId);
	}

	@Patch(':notificationId/read')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Marcar como leída una notificación propia' })
	async markAsRead(
		@Headers('x-holding-id') holdingId: string,
		@Request() request: RequestWithUser,
		@Param('notificationId') notificationId: string
	) {
		return this.notificationsService.markAsRead(holdingId, request.user?.id || request.user?.sub, notificationId);
	}
}

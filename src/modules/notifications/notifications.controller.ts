import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { RequestWithUser } from '@/core/interfaces/request-with-user.interface';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ListNotificationsDto, ReplaceSalesforceStagingBlockedSubscriptionsDto } from './dtos/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
@Controller('notifications')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
export class NotificationsController {
	constructor(private readonly notificationsService: NotificationsService) {}

	@Get()
	@ApiOperation({ summary: 'Listar las notificaciones del usuario autenticado' })
	async list(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Query() query: ListNotificationsDto) {
		return this.notificationsService.listForAuthenticatedUser(holdingId, request.user?.id || request.user?.sub, query);
	}

	@Get('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Listar suscripciones por rol para bloqueos de staging Salesforce' })
	async listSalesforceStagingBlockedSubscriptions(@HoldingId() holdingId: string, @Request() request: RequestWithUser) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, request.user?.id || request.user?.sub);
		return this.notificationsService.listSalesforceStagingBlockedSubscriptions(holdingId);
	}

	@Put('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Reemplazar suscripciones por rol para bloqueos de staging Salesforce' })
	async replaceSalesforceStagingBlockedSubscriptions(
		@HoldingId() holdingId: string,
		@Request() request: RequestWithUser,
		@Body() dto: ReplaceSalesforceStagingBlockedSubscriptionsDto
	) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, request.user?.id || request.user?.sub);
		return this.notificationsService.replaceSalesforceStagingBlockedSubscriptions(holdingId, dto);
	}

	@Get(':notificationId')
	@ApiOperation({ summary: 'Obtener el detalle de una notificación propia' })
	async getOne(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Param('notificationId') notificationId: string) {
		return this.notificationsService.getForAuthenticatedUser(holdingId, request.user?.id || request.user?.sub, notificationId);
	}

	@Patch(':notificationId/read')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Marcar como leída una notificación propia' })
	async markAsRead(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Param('notificationId') notificationId: string) {
		return this.notificationsService.markAsRead(holdingId, request.user?.id || request.user?.sub, notificationId);
	}
}

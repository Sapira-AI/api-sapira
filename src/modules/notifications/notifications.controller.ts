import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { RequestWithUser } from '@/core/interfaces/request-with-user.interface';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { SuperAdminOnlyRoute } from '@/guards/super-admin-only.guard';

import {
	ListNotificationsDto,
	MentionableUsersQueryDto,
	NotificationFiltersDto,
	NotificationIdsDto,
	ReplaceSalesforceStagingBlockedSubscriptionsDto,
	SystemUpdateDto,
	UpdateNotificationPreferencesDto,
} from './dtos/notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * `:notificationId` solo acepta un UUID: así `GET /notifications/tasks` (otro controlador, `TasksModule`) y las rutas fijas de aquí no se
 * confunden con un id, sin depender del orden de registro.
 */
const NOTIFICATION_ID = ':notificationId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';

const authIdOf = (request: RequestWithUser) => request.user?.id || request.user?.sub;

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', description: 'ID del holding activo', required: true })
@Controller('notifications')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
export class NotificationsController {
	constructor(private readonly notificationsService: NotificationsService) {}

	@Get()
	@ApiOperation({ summary: 'Listar las notificaciones del usuario autenticado (filtros y paginación)' })
	async list(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Query() query: ListNotificationsDto) {
		return this.notificationsService.listForAuthenticatedUser(holdingId, authIdOf(request), query);
	}

	@Get('counts')
	@ApiOperation({ summary: 'Sin leer: total, por módulo y por tipo' })
	async counts(@HoldingId() holdingId: string, @Request() request: RequestWithUser) {
		return this.notificationsService.countsForAuthenticatedUser(holdingId, authIdOf(request));
	}

	@Get('catalog')
	@ApiOperation({ summary: 'Catálogo de tipos (etiqueta, módulo, ícono, gravedad) y módulos' })
	catalog() {
		return this.notificationsService.catalog();
	}

	@Get('preferences')
	@ApiOperation({ summary: 'Preferencias del usuario en el holding: campana y correo por tipo, resumen semanal' })
	async getPreferences(@HoldingId() holdingId: string, @Request() request: RequestWithUser) {
		return this.notificationsService.getPreferences(holdingId, authIdOf(request));
	}

	@Put('preferences')
	@ApiOperation({ summary: 'Actualizar las preferencias del usuario en el holding' })
	async updatePreferences(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Body() dto: UpdateNotificationPreferencesDto) {
		return this.notificationsService.updatePreferences(holdingId, authIdOf(request), dto);
	}

	@Get('mentionable-users')
	@ApiOperation({ summary: 'Miembros activos del holding para mencionar con @ (Actividad del Cliente 360)' })
	async mentionableUsers(@HoldingId() holdingId: string, @Query() query: MentionableUsersQueryDto) {
		return this.notificationsService.mentionableUsers(holdingId, query.search, query.limit);
	}

	@Post('system-updates')
	@SuperAdminOnlyRoute()
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Novedad del sistema para todos los usuarios activos de todos los holdings (solo super admin; idempotente por slug)' })
	async systemUpdate(@Body() dto: SystemUpdateDto) {
		return this.notificationsService.notifySystemUpdate({ slug: dto.slug, title: dto.title, message: dto.summary });
	}

	@Post('read-all')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Marcar como leídas todas las que cumplen los filtros' })
	async readAll(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Body() filters: NotificationFiltersDto) {
		return this.notificationsService.markAllAsRead(holdingId, authIdOf(request), filters);
	}

	@Post('archive')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Archivar notificaciones propias (solo para este usuario)' })
	async archive(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Body() dto: NotificationIdsDto) {
		return this.notificationsService.setArchived(holdingId, authIdOf(request), dto.ids, true);
	}

	@Post('unarchive')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Devolver a la bandeja notificaciones archivadas' })
	async unarchive(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Body() dto: NotificationIdsDto) {
		return this.notificationsService.setArchived(holdingId, authIdOf(request), dto.ids, false);
	}

	@Get('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Listar suscripciones por rol de los tipos de siempre (front actual)' })
	async listSalesforceStagingBlockedSubscriptions(@HoldingId() holdingId: string, @Request() request: RequestWithUser) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, authIdOf(request));
		return this.notificationsService.listSalesforceStagingBlockedSubscriptions(holdingId);
	}

	@Put('subscriptions/salesforce-staging-blocked')
	@ApiOperation({ summary: 'Reemplazar suscripciones por rol de los tipos de siempre (front actual)' })
	async replaceSalesforceStagingBlockedSubscriptions(
		@HoldingId() holdingId: string,
		@Request() request: RequestWithUser,
		@Body() dto: ReplaceSalesforceStagingBlockedSubscriptionsDto
	) {
		await this.notificationsService.assertCanManageSubscriptions(holdingId, authIdOf(request));
		return this.notificationsService.replaceSalesforceStagingBlockedSubscriptions(holdingId, dto);
	}

	@Get(NOTIFICATION_ID)
	@ApiOperation({ summary: 'Detalle de una notificación propia con "Qué pasó" y "Qué hacer"' })
	async getOne(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Param('notificationId') notificationId: string) {
		return this.notificationsService.getForAuthenticatedUser(holdingId, authIdOf(request), notificationId);
	}

	@Patch(`${NOTIFICATION_ID}/read`)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Marcar como leída una notificación propia' })
	async markAsRead(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Param('notificationId') notificationId: string) {
		return this.notificationsService.markAsRead(holdingId, authIdOf(request), notificationId);
	}

	@Patch(`${NOTIFICATION_ID}/unread`)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Marcar como no leída una notificación propia' })
	async markAsUnread(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Param('notificationId') notificationId: string) {
		return this.notificationsService.markAsUnread(holdingId, authIdOf(request), notificationId);
	}
}

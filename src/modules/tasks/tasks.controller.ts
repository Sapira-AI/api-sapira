import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { RequestWithUser } from '@/core/interfaces/request-with-user.interface';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { NotificationTasksQueryDto } from '@/modules/notifications/dtos/notifications.dto';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { TasksService } from './tasks.service';

/**
 * `GET /notifications/tasks` (Notificaciones v2 §4). Vive en `TasksModule` y no en `NotificationsModule` porque lee Facturación, Contratos e
 * Ingresos, y Contratos ya depende de Notificaciones (se evita el ciclo de módulos). El `:notificationId` del otro controlador solo acepta
 * UUID, así esta ruta fija nunca se confunde con un id.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', description: 'ID del holding activo', required: true })
@Controller('notifications/tasks')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
export class TasksController {
	constructor(
		private readonly tasks: TasksService,
		private readonly notifications: NotificationsService
	) {}

	/** Compañías: `company_ids` si viene; si no, "Mis compañías" del usuario; `all=true` = todas (contrato §8.1). */
	@Get()
	@ApiOperation({ summary: 'Tareas del holding para hoy (calculadas en vivo; solo las con algo por hacer)' })
	async list(@HoldingId() holdingId: string, @Request() request: RequestWithUser, @Query() query: NotificationTasksQueryDto) {
		const companies = query.all
			? []
			: (query.company_ids ?? (await this.notifications.myCompaniesForAuthUser(holdingId, String(request.user?.id || request.user?.sub))));

		return this.tasks.pending(holdingId, query.as_of, companies);
	}
}

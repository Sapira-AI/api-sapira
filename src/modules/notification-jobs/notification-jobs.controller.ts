import { Controller, HttpCode, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { RequestWithUser } from '@/core/interfaces/request-with-user.interface';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { SuperAdminOnlyRoute } from '@/guards/super-admin-only.guard';

import { NotificationDigestService } from './notification-digest.service';

/** `POST /notifications/digest/preview` (contrato §8.4): HTML de ejemplo del resumen semanal del holding activo. Solo super admin. */
@ApiTags('Notifications')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', description: 'ID del holding activo', required: true })
@Controller('notifications/digest')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
export class NotificationJobsController {
	constructor(private readonly digest: NotificationDigestService) {}

	@Post('preview')
	@SuperAdminOnlyRoute()
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Vista previa del resumen semanal del holding activo para quien llama (no envía nada)' })
	async preview(@HoldingId() holdingId: string, @Request() request: RequestWithUser) {
		return this.digest.preview(holdingId, String(request.user?.id || request.user?.sub));
	}
}

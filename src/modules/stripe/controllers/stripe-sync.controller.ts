import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SyncJobStatusDto } from '../dto/sync-progress.dto';
import { SyncRequestDto } from '../dto/sync-request.dto';
import { StripeSyncService } from '../services/stripe-sync.service';

@ApiTags('Stripe Sync')
@Controller('stripe/sync')
@UseGuards(SupabaseAuthGuard)
export class StripeSyncController {
	constructor(private readonly stripeSyncService: StripeSyncService) {}

	@Post()
	@ApiOperation({
		summary: 'Iniciar sincronización de datos de Stripe',
		description: 'Inicia un job de sincronización en background y retorna el jobId para hacer polling del progreso',
	})
	@ApiResponse({
		status: 200,
		description: 'Job de sincronización iniciado',
	})
	@ApiResponse({
		status: 401,
		description: 'No autorizado',
	})
	async syncStripeData(@Headers('x-holding-id') holdingId: string, @Body() syncRequest: SyncRequestDto): Promise<{ jobId: string }> {
		return this.stripeSyncService.syncAll(holdingId, syncRequest.batchSize);
	}

	@Get(':jobId/status')
	@ApiOperation({
		summary: 'Consultar estado de sincronización',
		description: 'Obtiene el progreso actual y estadísticas de un job de sincronización',
	})
	@ApiResponse({
		status: 200,
		description: 'Estado del job',
		type: SyncJobStatusDto,
	})
	@ApiResponse({
		status: 404,
		description: 'Job no encontrado',
	})
	async getJobStatus(@Param('jobId') jobId: string): Promise<SyncJobStatusDto> {
		return this.stripeSyncService.getJobStatus(jobId);
	}
}

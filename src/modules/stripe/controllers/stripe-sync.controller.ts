import { Body, Controller, Get, Headers, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SyncJobStatusDto } from '../dto/sync-progress.dto';
import { SyncRequestDto } from '../dto/sync-request.dto';
import { StripeSyncService } from '../services/stripe-sync.service';

@ApiTags('Stripe Sync')
@Controller('stripe/sync')
@UseGuards(SupabaseAuthGuard)
export class StripeSyncController {
	private readonly logger = new Logger(StripeSyncController.name);

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
		this.logger.log('═══════════════════════════════════════════════════════════════');
		this.logger.log('🚀 INICIO: Solicitud de sincronización de Stripe desde frontend');
		this.logger.log('═══════════════════════════════════════════════════════════════');
		this.logger.log(`📋 Parámetros recibidos:`);
		this.logger.log(`   - Holding ID: ${holdingId}`);
		this.logger.log(`   - Batch Size: ${syncRequest.batchSize || 100}`);
		this.logger.log(`   - Timestamp: ${new Date().toISOString()}`);

		const result = await this.stripeSyncService.syncAll(holdingId, syncRequest.batchSize);

		this.logger.log(`✅ Job de sincronización creado exitosamente`);
		this.logger.log(`   - Job ID: ${result.jobId}`);
		this.logger.log('═══════════════════════════════════════════════════════════════\n');

		return result;
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

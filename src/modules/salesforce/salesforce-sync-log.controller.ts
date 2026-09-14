import { Controller, Get, Headers, HttpStatus, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingAccessGuard } from '@/guards/holding-access.guard';

import { SalesforceSyncJobListDto, SalesforceSyncLogListDto } from './dtos/salesforce-sync-log.dto';
import { SalesforceSyncLogService } from './services/salesforce-sync-log.service';

/**
 * Consulta de la bitácora de la sincronización automática de Salesforce.
 * Todos los resultados quedan acotados al holding del header `x-holding-id`
 * salvo el listado de corridas, que admite una vista global explícita.
 */
@ApiTags('Salesforce Sync Logs')
@Controller('salesforce/sync-logs')
@UseGuards(SupabaseAuthGuard, HoldingAccessGuard)
@ApiBearerAuth()
export class SalesforceSyncLogController {
	constructor(private readonly syncLogService: SalesforceSyncLogService) {}

	@Get()
	@ApiOperation({ summary: 'Listar eventos detallados de la sincronización automática de Salesforce' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Eventos de bitácora obtenidos' })
	async listLogs(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceSyncLogListDto) {
		return this.syncLogService.list({
			holdingId,
			executionEnvironment: query.environment,
			level: query.level,
			stage: query.stage,
			jobId: query.jobId,
			salesforceOpportunityId: query.opportunityId,
			dateFrom: query.dateFrom,
			dateTo: query.dateTo,
			page: query.page,
			limit: query.limit,
		});
	}

	@Get('jobs')
	@ApiOperation({ summary: 'Listar corridas del scheduler de Salesforce con su resumen' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Corridas obtenidas' })
	async listJobs(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceSyncJobListDto) {
		return this.syncLogService.listJobs({
			holdingId: query.allHoldings === 'true' ? undefined : holdingId,
			executionEnvironment: query.environment,
			status: query.status,
			page: query.page,
			limit: query.limit,
		});
	}

	@Get('jobs/:jobId')
	@ApiOperation({ summary: 'Consultar una corrida del scheduler junto a los eventos del holding activo' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Corrida y eventos obtenidos' })
	async getJob(@Headers('x-holding-id') holdingId: string, @Param('jobId') jobId: string, @Query() query: SalesforceSyncLogListDto) {
		const job = await this.syncLogService.getJob(jobId);
		if (!job) {
			throw new NotFoundException('Corrida de sincronización Salesforce no encontrada');
		}

		const logs = await this.syncLogService.list({
			holdingId,
			jobId,
			level: query.level,
			stage: query.stage,
			page: query.page,
			limit: query.limit,
		});

		return { job, logs };
	}
}

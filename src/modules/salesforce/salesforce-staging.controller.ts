import { Body, Controller, Get, Headers, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceStagingService } from './services/salesforce-staging.service';

@ApiTags('Salesforce Staging')
@Controller('salesforce/staging')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SalesforceStagingController {
	constructor(
		private readonly stagingService: SalesforceStagingService,
		private readonly syncCompleteService: SalesforceSyncCompleteService
	) {}

	@Get('stats')
	@ApiOperation({ summary: 'Obtener estadísticas de staging de Salesforce' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Estadísticas obtenidas exitosamente' })
	async getStats(@Headers('x-holding-id') holdingId: string) {
		return this.stagingService.getStats(holdingId);
	}

	@Get('accounts')
	@ApiOperation({ summary: 'Listar staging de Accounts' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getAccounts(
		@Headers('x-holding-id') holdingId: string,
		@Query('search') search?: string,
		@Query('status') status?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.stagingService.getRecords(holdingId, 'accounts', {
			search,
			status,
			page: page ? Number(page) : undefined,
			limit: limit ? Number(limit) : undefined,
		});
	}

	@Get('opportunities')
	@ApiOperation({ summary: 'Listar staging de Opportunities' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getOpportunities(
		@Headers('x-holding-id') holdingId: string,
		@Query('search') search?: string,
		@Query('status') status?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.stagingService.getRecords(holdingId, 'opportunities', {
			search,
			status,
			page: page ? Number(page) : undefined,
			limit: limit ? Number(limit) : undefined,
		});
	}

	@Get('line-items')
	@ApiOperation({ summary: 'Listar staging de Opportunity Line Items' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getLineItems(
		@Headers('x-holding-id') holdingId: string,
		@Query('search') search?: string,
		@Query('status') status?: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.stagingService.getRecords(holdingId, 'line-items', {
			search,
			status,
			page: page ? Number(page) : undefined,
			limit: limit ? Number(limit) : undefined,
		});
	}

	@Post('reclassify')
	@ApiOperation({ summary: 'Reclasificar registros staging de Salesforce' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Registros reclasificados' })
	async reclassify(@Headers('x-holding-id') holdingId: string) {
		await this.syncCompleteService.reclassifyStaging(holdingId);
		return {
			success: true,
			message: 'Registros staging reclasificados exitosamente',
		};
	}

	@Post('process')
	@ApiOperation({ summary: 'Procesar staging de Salesforce hacia tablas finales' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Proceso completado' })
	async process(@Headers('x-holding-id') holdingId: string) {
		const stats = await this.syncCompleteService.processStaging(holdingId);
		return {
			success: true,
			stats,
		};
	}
}

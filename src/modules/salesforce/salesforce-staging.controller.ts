import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	SalesforceAccountImportDto,
	SalesforceAccountMappingViewDto,
	SalesforceAccountProcessDto,
	SalesforceOpportunityImportDto,
	SalesforceOpportunityPreviewDto,
	SalesforceOpportunityProcessDto,
	SalesforceOpportunityRetryDto,
	SalesforceSyncRunStartDto,
	SalesforceStagingListDto,
} from './dtos/salesforce-account-staging.dto';
import { SalesforceStagingService } from './services/salesforce-staging.service';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from './services/salesforce-sync-run.service';

@ApiTags('Salesforce Staging')
@Controller('salesforce/staging')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SalesforceStagingController {
	constructor(
		private readonly stagingService: SalesforceStagingService,
		private readonly syncCompleteService: SalesforceSyncCompleteService,
		private readonly syncRunService: SalesforceSyncRunService
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
	@ApiQuery({ name: 'statuses', required: false, example: 'create,update' })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getAccounts(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceStagingListDto) {
		return this.stagingService.getRecords(holdingId, 'accounts', {
			...query,
			statuses: query.statuses?.split(','),
		});
	}

	@Get('accounts/mapping-view')
	@ApiOperation({ summary: 'Listar Accounts staging para la grilla de mapeo de clientes' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'country', required: false })
	@ApiQuery({ name: 'countryCode', required: false })
	@ApiQuery({ name: 'mappingState', required: false, enum: ['all', 'mapped', 'unmapped', 'outdated'] })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getAccountsMappingView(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceAccountMappingViewDto): Promise<unknown> {
		return this.stagingService.getAccountsMappingView(holdingId, query);
	}

	@Get('opportunities')
	@ApiOperation({ summary: 'Listar staging de Opportunities' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'statuses', required: false, example: 'create,update' })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getOpportunities(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceStagingListDto) {
		return this.stagingService.getRecords(holdingId, 'opportunities', {
			...query,
			statuses: query.statuses?.split(','),
		});
	}

	@Get('line-items')
	@ApiOperation({ summary: 'Listar staging de Opportunity Line Items' })
	@ApiQuery({ name: 'search', required: false })
	@ApiQuery({ name: 'status', required: false })
	@ApiQuery({ name: 'statuses', required: false, example: 'create,update' })
	@ApiQuery({ name: 'page', required: false })
	@ApiQuery({ name: 'limit', required: false })
	async getLineItems(@Headers('x-holding-id') holdingId: string, @Query() query: SalesforceStagingListDto) {
		return this.stagingService.getRecords(holdingId, 'line-items', {
			...query,
			statuses: query.statuses?.split(','),
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

	@Post('accounts/import')
	@ApiOperation({ summary: 'Importar Accounts de Salesforce a staging' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Accounts importadas a staging' })
	async importAccounts(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceAccountImportDto) {
		return this.syncCompleteService.syncAccountsToStaging(holdingId, body);
	}

	@Post('accounts/reclassify')
	@ApiOperation({ summary: 'Reclasificar solo staging de Accounts' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Accounts reclasificadas' })
	async reclassifyAccounts(@Headers('x-holding-id') holdingId: string) {
		await this.syncCompleteService.reclassifyAccountsStaging(holdingId);
		return {
			success: true,
			message: 'Accounts staging reclasificadas exitosamente',
		};
	}

	@Post('accounts/process')
	@ApiOperation({ summary: 'Procesar staging de Accounts hacia tablas finales' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Accounts procesadas' })
	async processAccounts(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceAccountProcessDto) {
		const stats = await this.syncCompleteService.processAccountsStaging(holdingId, body.salesforceIds, body.clientFields);
		return {
			success: true,
			stats,
		};
	}

	@Post('opportunities/import')
	@ApiOperation({ summary: 'Importar Opportunities ganadas de Salesforce a staging y clasificarlas' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Opportunities importadas y clasificadas en staging' })
	async importOpportunities(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceOpportunityImportDto) {
		return this.syncCompleteService.syncOpportunitiesToStaging(holdingId, body.dateFrom, body.dateTo, body.opportunityIds);
	}

	@Post('opportunities/import/run')
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Crear ejecución asíncrona de Opportunities hacia staging' })
	async startOpportunitiesImportRun(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceSyncRunStartDto) {
		const run = await this.syncRunService.createRun(holdingId, 'update_staging', body.opportunityIds, {
			dateFrom: body.dateFrom,
			dateTo: body.dateTo,
		});
		return { run };
	}

	@Post('opportunities/preview')
	@ApiOperation({ summary: 'Revisar Opportunities de Salesforce contra staging sin escribir datos' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Opportunities comparadas contra staging' })
	async previewOpportunities(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceOpportunityPreviewDto) {
		return this.syncCompleteService.previewOpportunitiesAgainstStaging(holdingId, body.dateFrom, body.dateTo, body.opportunityIds, body.stages);
	}

	@Post('opportunities/process')
	@ApiOperation({ summary: 'Procesar staging de Opportunities hacia tablas finales' })
	@ApiResponse({ status: HttpStatus.OK, description: 'Opportunities procesadas desde staging' })
	async processOpportunities(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceOpportunityProcessDto) {
		const stats = await this.syncCompleteService.processOpportunitiesStaging(holdingId, body.opportunityIds);
		return {
			success: true,
			stats,
		};
	}

	@Post('opportunities/process/run')
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Crear ejecución asíncrona desde staging hacia tablas finales' })
	async startOpportunitiesProcessRun(@Headers('x-holding-id') holdingId: string, @Body() body: SalesforceSyncRunStartDto) {
		const run = await this.syncRunService.createRun(holdingId, 'process_final', body.opportunityIds);
		return { run };
	}

	@Post('opportunities/:opportunityId/retry')
	@HttpCode(HttpStatus.ACCEPTED)
	@ApiOperation({ summary: 'Reintentar una oportunidad Salesforce bloqueada desde una notificación' })
	async retryOpportunity(
		@Headers('x-holding-id') holdingId: string,
		@Param('opportunityId') opportunityId: string,
		@Body() body: SalesforceOpportunityRetryDto
	) {
		const run = await this.syncRunService.createRun(holdingId, body.mode || 'retry_full', [opportunityId]);
		return { run };
	}

	@Get('runs/:runId')
	@ApiOperation({ summary: 'Consultar progreso de una ejecución Salesforce' })
	async getRun(@Headers('x-holding-id') holdingId: string, @Param('runId') runId: string) {
		return { run: await this.syncRunService.getRun(holdingId, runId) };
	}

	@Post('runs/:runId/cancel')
	@ApiOperation({ summary: 'Solicitar cancelación de una ejecución Salesforce' })
	async cancelRun(@Headers('x-holding-id') holdingId: string, @Param('runId') runId: string) {
		return { run: await this.syncRunService.requestCancellation(holdingId, runId) };
	}
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BigQueryService } from './bigquery.service';
import { QueryDto } from './dtos/query.dto';
import { BigQueryResult } from './interfaces/bigquery-result.interface';
import { ProjectInfo } from './interfaces/project-info.interface';

@ApiTags('BigQuery')
@Controller('bigquery')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class BigQueryController {
	constructor(private readonly bigQueryService: BigQueryService) {}

	@Get('project-info')
	@ApiOperation({
		summary: 'Obtener información del proyecto de BigQuery',
		description: 'Retorna el ID del proyecto y el email de la cuenta de servicio configurada.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Información del proyecto obtenida exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getProjectInfo(): Promise<ProjectInfo> {
		return this.bigQueryService.getProjectInfo();
	}

	@Post('query')
	@ApiOperation({
		summary: 'Ejecutar consulta SQL en BigQuery',
		description: 'Ejecuta una consulta SQL personalizada en BigQuery y retorna los resultados.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Consulta ejecutada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Consulta inválida o BigQuery no configurado',
	})
	@HttpCode(HttpStatus.OK)
	async executeQuery(@Body() dto: QueryDto): Promise<BigQueryResult> {
		return this.bigQueryService.executeQuery(dto);
	}

	@Get('datasets')
	@ApiOperation({
		summary: 'Obtener lista de datasets',
		description: 'Retorna la lista de todos los datasets disponibles en el proyecto de BigQuery.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Datasets obtenidos exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getDatasets(): Promise<string[]> {
		return this.bigQueryService.getDatasets();
	}

	@Get('datasets/:datasetId/tables')
	@ApiOperation({
		summary: 'Obtener tablas de un dataset',
		description: 'Retorna la lista de tablas disponibles en un dataset específico.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Tablas obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getTables(@Param('datasetId') datasetId: string): Promise<string[]> {
		return this.bigQueryService.getTables(datasetId);
	}
}

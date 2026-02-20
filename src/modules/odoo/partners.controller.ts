import { Body, Controller, Delete, Get, Header, Headers, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ProcessPartnersDto, ProcessPartnersResponseDto } from './dtos/process-partners.dto';
import { PartnersProcessorService } from './services/partners-processor.service';

@ApiTags('Odoo Partners')
@Controller('odoo/partners')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class PartnersController {
	constructor(private readonly partnersProcessorService: PartnersProcessorService) {}

	@Post('process')
	@ApiOperation({
		summary: 'Procesar partners de Odoo desde staging',
		description: 'Procesa los partners de odoo_partners_stg y los integra en client_entities usando el mapeo configurado',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Partners procesados exitosamente',
		type: ProcessPartnersResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos de entrada inválidos',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async processPartners(@Body() dto: ProcessPartnersDto): Promise<ProcessPartnersResponseDto> {
		return await this.partnersProcessorService.processPartners(dto);
	}

	@Get('status-counts')
	@Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
	@Header('Pragma', 'no-cache')
	@Header('Expires', '0')
	@ApiOperation({
		summary: 'Obtener conteos de partners por estado',
		description: 'Retorna la cantidad de partners en cada estado de procesamiento',
	})
	async getStatusCounts(@Headers('x-holding-id') holdingId: string): Promise<{
		create: number;
		update: number;
		processed: number;
		error: number;
		null: number;
	}> {
		return this.partnersProcessorService.getStatusCounts(holdingId);
	}

	@Get('staging')
	@Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
	@Header('Pragma', 'no-cache')
	@Header('Expires', '0')
	@ApiOperation({
		summary: 'Obtener partners staging con paginación',
		description: 'Retorna partners de la tabla staging con paginación y filtros',
	})
	async getStagingPartners(
		@Headers('x-holding-id') holdingId: string,
		@Query('page') page?: number,
		@Query('limit') limit?: number,
		@Query('statusFilter') statusFilter?: string
	): Promise<{
		partners: any[];
		total: number;
		page: number;
		totalPages: number;
	}> {
		const statusArray = statusFilter ? statusFilter.split(',') : undefined;
		return this.partnersProcessorService.getStagingPartners(holdingId, page || 1, limit || 20, statusArray);
	}

	@Delete('clean-processed')
	@ApiOperation({
		summary: 'Limpiar partners procesados',
		description: 'Elimina todos los partners con estado "processed" de la tabla staging',
	})
	async cleanProcessedPartners(@Headers('x-holding-id') holdingId: string): Promise<{
		deleted_count: number;
		message: string;
	}> {
		return this.partnersProcessorService.cleanProcessedPartners(holdingId);
	}
}

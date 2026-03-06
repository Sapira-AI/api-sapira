import { Body, Controller, Delete, Get, Header, Headers, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ProcessPartnersDto, ProcessPartnersResponseDto } from './dtos/process-partners.dto';
import { OdooPartnersService } from './odoo-partners.service';

@ApiTags('Odoo Partners')
@Controller('odoo-partners')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class OdooPartnersController {
	constructor(private readonly odooPartnersService: OdooPartnersService) {}

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
		return await this.odooPartnersService.processPartners(dto);
	}

	@Post('sync-partner')
	@ApiOperation({
		summary: 'Sincronizar un partner específico de Odoo a staging',
		description:
			'Obtiene un partner específico de Odoo por su ID y lo guarda en odoo_partners_stg. Usa automáticamente la conexión activa del holding.',
	})
	@ApiHeader({
		name: 'x-holding-id',
		description: 'ID del holding',
		required: true,
		example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
	})
	@ApiBody({
		schema: {
			type: 'object',
			required: ['odoo_partner_id'],
			properties: {
				odoo_partner_id: {
					type: 'number',
					description: 'ID del partner en Odoo',
					example: 16252,
				},
			},
		},
	})
	@ApiOkResponse({
		description: 'Partner sincronizado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				partner_synced: { type: 'boolean' },
				partner_data: {
					type: 'object',
					description: 'Datos del partner guardado en staging',
				},
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Error al sincronizar partner' })
	async syncPartnerById(@Headers('x-holding-id') holdingId: string, @Body() body: { odoo_partner_id: number }) {
		return await this.odooPartnersService.syncPartnerById(holdingId, body.odoo_partner_id);
	}

	@Get('status-counts')
	@Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
	@Header('Pragma', 'no-cache')
	@Header('Expires', '0')
	@ApiOperation({
		summary: 'Obtener conteos de partners por estado',
		description: 'Retorna la cantidad de partners en cada estado de procesamiento',
	})
	@ApiHeader({
		name: 'x-holding-id',
		description: 'ID del holding',
		required: true,
		example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
	})
	async getStatusCounts(@Headers('x-holding-id') holdingId: string): Promise<{
		create: number;
		update: number;
		processed: number;
		error: number;
		null: number;
	}> {
		return this.odooPartnersService.getStatusCounts(holdingId);
	}

	@Get('staging')
	@Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
	@Header('Pragma', 'no-cache')
	@Header('Expires', '0')
	@ApiOperation({
		summary: 'Obtener partners staging con paginación',
		description: 'Retorna partners de la tabla staging con paginación y filtros',
	})
	@ApiHeader({
		name: 'x-holding-id',
		description: 'ID del holding',
		required: true,
		example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
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
		return this.odooPartnersService.getStagingPartners(holdingId, page || 1, limit || 20, statusArray);
	}

	@Delete('clean-processed')
	@ApiOperation({
		summary: 'Limpiar partners procesados',
		description: 'Elimina todos los partners con estado "processed" de la tabla staging',
	})
	@ApiHeader({
		name: 'x-holding-id',
		description: 'ID del holding',
		required: true,
		example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
	})
	async cleanProcessedPartners(@Headers('x-holding-id') holdingId: string): Promise<{
		deleted_count: number;
		message: string;
	}> {
		return this.odooPartnersService.cleanProcessedPartners(holdingId);
	}
}

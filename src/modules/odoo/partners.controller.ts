import { Body, Controller, HttpStatus, Post, UseGuards } from '@nestjs/common';
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
}

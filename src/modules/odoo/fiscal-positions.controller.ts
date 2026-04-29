import { Controller, Get, Headers, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	CompanyDefaultTaxes,
	FiscalPosition,
	FiscalPositionComplete,
	FiscalPositionsService,
	GetFiscalPositionsResponseDto,
	GetTaxesResponseDto,
	PartnerApplicableTaxes,
} from './services/fiscal-positions.service';

@Controller('odoo/fiscal-positions')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class FiscalPositionsController {
	constructor(private readonly fiscalPositionsService: FiscalPositionsService) {}

	@Get()
	async getFiscalPositions(
		@Headers('x-holding-id') holdingId: string,
		@Query('company_id') companyId?: number
	): Promise<GetFiscalPositionsResponseDto> {
		return await this.fiscalPositionsService.getFiscalPositions(holdingId, companyId);
	}

	@Get('company/:companyId/default-taxes')
	async getCompanyDefaultTaxes(
		@Headers('x-holding-id') holdingId: string,
		@Param('companyId', ParseIntPipe) companyId: number
	): Promise<CompanyDefaultTaxes | null> {
		return await this.fiscalPositionsService.getCompanyDefaultTaxes(holdingId, companyId);
	}

	@Get('partner/:partnerId/applicable-taxes')
	async getPartnerApplicableTaxes(
		@Headers('x-holding-id') holdingId: string,
		@Param('partnerId', ParseIntPipe) partnerId: number
	): Promise<PartnerApplicableTaxes | null> {
		return await this.fiscalPositionsService.getPartnerApplicableTaxes(holdingId, partnerId);
	}

	@Get(':id/complete')
	async getFiscalPositionComplete(
		@Headers('x-holding-id') holdingId: string,
		@Param('id', ParseIntPipe) id: number
	): Promise<FiscalPositionComplete | null> {
		return await this.fiscalPositionsService.getFiscalPositionComplete(holdingId, id);
	}

	@Get('taxes')
	async getTaxesByIds(@Headers('x-holding-id') holdingId: string, @Query('ids') ids: string): Promise<GetTaxesResponseDto> {
		const taxIds = ids
			.split(',')
			.map((id) => parseInt(id.trim(), 10))
			.filter((id) => !isNaN(id));
		return await this.fiscalPositionsService.getTaxesByIds(holdingId, taxIds);
	}

	@Get(':id')
	async getFiscalPositionById(@Headers('x-holding-id') holdingId: string, @Param('id', ParseIntPipe) id: number): Promise<FiscalPosition | null> {
		return await this.fiscalPositionsService.getFiscalPositionById(holdingId, id);
	}
}

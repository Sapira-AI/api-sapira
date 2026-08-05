import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { DashboardService } from './dashboard.service';

class DashboardQueryDto {
	@IsOptional()
	@IsDateString()
	as_of?: string;
}

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
@Controller('dashboard')
export class DashboardController {
	constructor(private readonly dashboardService: DashboardService) {}

	@Get('home')
	@ApiOperation({ summary: 'Obtener KPIs y tareas del dashboard para el holding seleccionado' })
	async getHome(@Request() request, @Query() query: DashboardQueryDto) {
		return this.dashboardService.getHome(request.user?.id || request.user?.sub, query.as_of ? new Date(`${query.as_of}T00:00:00.000Z`) : new Date());
	}
}

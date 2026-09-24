import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { DashboardService } from './dashboard.service';

class DashboardQueryDto {
	@IsOptional()
	@IsDateString()
	as_of?: string;
}

@ApiTags('Dashboard')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@Controller('dashboard')
export class DashboardController {
	constructor(private readonly dashboardService: DashboardService) {}

	@Get('home')
	@ApiOperation({ summary: 'Obtener KPIs y tareas del dashboard para el holding activo' })
	async getHome(@HoldingId() holdingId: string, @Query() query: DashboardQueryDto) {
		return this.dashboardService.getHome(holdingId, query.as_of ? new Date(`${query.as_of}T00:00:00.000Z`) : new Date());
	}
}

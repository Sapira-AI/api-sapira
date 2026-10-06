import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import {
	InvoiceConsolidationRuleDto,
	InvoiceConsolidationRulePauseDto,
	InvoiceConsolidationRulePreviewDto,
} from './dtos/invoice-consolidation-rule.dto';
import { InvoiceConsolidationRulesService } from './invoice-consolidation-rules.service';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');
const ENTITY_PARAM = { name: 'id', type: String, description: 'UUID de la razón social (client_entities)' };

/** Unificación recurrente de facturas de una razón social (Razón social 360; `docs/v2-rediseno/spec-unificacion-recurrente.md`). */
@ApiTags('Invoice consolidation rules')
@Controller('client-entities/:id/invoice-consolidation')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class InvoiceConsolidationRulesController {
	constructor(private readonly rules: InvoiceConsolidationRulesService) {}

	@Get()
	@ApiOperation({ summary: 'Regla, contratos activos, contratos nuevos fuera de la regla y estado por mes (unified · pending · blocked · single)' })
	@ApiParam(ENTITY_PARAM)
	async view(@Param('id', ParseUUIDPipe) id: string, @HoldingId() holdingId: string) {
		return await this.rules.view(id, holdingId);
	}

	@Post('preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa por mes (will_unify · already_unified · blocked · single) con la fecha de emisión del principal. No escribe',
	})
	@ApiParam(ENTITY_PARAM)
	async preview(@Param('id', ParseUUIDPipe) id: string, @Body() body: InvoiceConsolidationRulePreviewDto, @HoldingId() holdingId: string) {
		return await this.rules.preview(id, body, holdingId);
	}

	@Put()
	@ApiOperation({
		summary: 'Guarda la regla (activa) y unifica ya todas las Por Emitir de esos contratos, también de meses pasados',
		description:
			'400 sin `confirm_issue_date`, con menos de 2 contratos, contratos que no son activos de la razón social o el principal fuera de la lista. `result.unified` / `result.blocked` = documentos (mes y moneda) unificados / no unificados',
	})
	@ApiParam(ENTITY_PARAM)
	async save(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: InvoiceConsolidationRuleDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.rules.save(id, body, holdingId, authIdOf(req));
	}

	@Post('pause')
	@HttpCode(200)
	@ApiOperation({ summary: 'Pausa la regla; con undo_pending deshace las unificadas de la regla que siguen Por Emitir sin borrador en el ERP' })
	@ApiParam(ENTITY_PARAM)
	async pause(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: InvoiceConsolidationRulePauseDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.rules.pause(id, body, holdingId, authIdOf(req));
	}

	@Post('resume')
	@HttpCode(200)
	@ApiOperation({ summary: 'Reactiva la regla y unifica lo pendiente (sin body)' })
	@ApiParam(ENTITY_PARAM)
	async resume(@Param('id', ParseUUIDPipe) id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.rules.resume(id, holdingId, authIdOf(req));
	}
}

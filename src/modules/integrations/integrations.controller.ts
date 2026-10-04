import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Query,
	Req,
	UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import {
	AcceptSuggestionsDto,
	ConfirmQueryDto,
	CrmConnectionDto,
	CrmFetchDto,
	CrmImportDto,
	DatosConnectionDto,
	DeleteMappingQueryDto,
	DiscardRecordsDto,
	ErpConnectionDto,
	ImportRecordsDto,
	MappingKeysDto,
	MappingOptionsQueryDto,
	MappingQueryDto,
	PutMappingDto,
	RecordsQueryDto,
	RestoreRecordsDto,
	RuleFieldsQueryDto,
	RulesDto,
	RunsQueryDto,
	SetActiveDto,
	SettingsDto,
	StripeConnectionDto,
	SyncDto,
	TaxesQueryDto,
} from './dtos/integrations.dto';
import { IntegrationsService } from './integrations.service';

interface IntegrationsRequest {
	user?: { sub?: string; id?: string };
	permissionContext?: PermissionContext;
}

const VIEW = PERMISSION_CODES.viewIntegrations;
const EDIT = PERMISSION_CODES.editIntegrations;

/**
 * Integraciones v2 (`docs/v2-rediseno/contrato-api-integraciones.md`). Lectura con `VIEW_INTEGRACIONES`, cambios con `EDIT_INTEGRACIONES`;
 * el mapeo de campos además exige super admin o Admin Técnico. Nunca devuelve claves. Las rutas viejas (`/odoo`, `/salesforce`, `/stripe`,
 * `/bigquery`) no cambian.
 */
@ApiTags('Integraciones v2')
@Controller('integrations')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(VIEW)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class IntegrationsController {
	constructor(private readonly service: IntegrationsService) {}

	private actor(req: IntegrationsRequest) {
		return this.service.actorOf(String(req.user?.sub ?? req.user?.id ?? ''), req.permissionContext);
	}

	/** Stripe tiene varias cuentas: su conexión va por `/stripe/connections`. */
	private single(tipo: string) {
		if (tipo === 'stripe') throw new NotFoundException('Stripe tiene varias cuentas: usa /integrations/stripe/connections');

		return this.service.adapter(tipo);
	}

	// ── Resumen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

	@Get()
	@ApiOperation({ summary: 'Resumen por tipo de integración' })
	summary(@HoldingId() holdingId: string) {
		return this.service.summary(holdingId);
	}

	// ── Conexión (ERP, CRM, almacén de datos) ───────────────────────────────────────────────────────────────────────────────

	@Put('erp/connection')
	@RequirePermission(EDIT)
	saveErp(@HoldingId() holdingId: string, @Body() body: ErpConnectionDto, @Req() req: IntegrationsRequest) {
		return this.service.erp.saveConnection(holdingId, body, this.actor(req));
	}

	@Put('crm/connection')
	@RequirePermission(EDIT)
	saveCrm(@HoldingId() holdingId: string, @Body() body: CrmConnectionDto, @Req() req: IntegrationsRequest) {
		return this.service.crm.saveConnection(holdingId, body, this.actor(req));
	}

	@Put('datos/connection')
	@RequirePermission(EDIT)
	saveDatos(@HoldingId() holdingId: string, @Body() body: DatosConnectionDto, @Req() req: IntegrationsRequest) {
		return this.service.datos.saveConnection(holdingId, body, this.actor(req));
	}

	// ── Stripe: cuentas ─────────────────────────────────────────────────────────────────────────────────────────────────────

	@Get('stripe/connections')
	listStripe(@HoldingId() holdingId: string) {
		return this.service.stripe.listConnections(holdingId);
	}

	@Post('stripe/connections')
	@RequirePermission(EDIT)
	createStripe(@HoldingId() holdingId: string, @Body() body: StripeConnectionDto, @Req() req: IntegrationsRequest) {
		return this.service.stripe.saveConnection(holdingId, body, this.actor(req));
	}

	@Get('stripe/connections/:id')
	getStripe(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.service.stripe.getConnectionById(holdingId, id);
	}

	@Put('stripe/connections/:id')
	@RequirePermission(EDIT)
	updateStripe(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: StripeConnectionDto,
		@Req() req: IntegrationsRequest
	) {
		return this.service.stripe.saveConnection(holdingId, body, this.actor(req), id);
	}

	@Post('stripe/connections/:id/test')
	@HttpCode(200)
	@RequirePermission(EDIT)
	testStripe(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.service.stripe.testConnection(holdingId, id);
	}

	@Patch('stripe/connections/:id/active')
	@RequirePermission(EDIT)
	activeStripe(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetActiveDto) {
		return this.service.stripe.setActive(holdingId, body.active, id);
	}

	@Delete('stripe/connections/:id')
	@HttpCode(204)
	@RequirePermission(EDIT)
	async deleteStripe(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Query() query: ConfirmQueryDto): Promise<void> {
		await this.service.deleteConnection(holdingId, 'stripe', query.confirm === true, id);
	}

	// ── Conexión genérica ───────────────────────────────────────────────────────────────────────────────────────────────────

	@Get(':tipo/connection')
	getConnection(@HoldingId() holdingId: string, @Param('tipo') tipo: string) {
		return this.single(tipo).getConnection(holdingId);
	}

	@Post(':tipo/connection/test')
	@HttpCode(200)
	@RequirePermission(EDIT)
	testConnection(@HoldingId() holdingId: string, @Param('tipo') tipo: string) {
		return this.single(tipo).testConnection(holdingId);
	}

	@Patch(':tipo/connection/active')
	@RequirePermission(EDIT)
	setActive(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: SetActiveDto) {
		return this.single(tipo).setActive(holdingId, body.active);
	}

	@Delete(':tipo/connection')
	@HttpCode(204)
	@RequirePermission(EDIT)
	async deleteConnection(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Query() query: ConfirmQueryDto): Promise<void> {
		this.single(tipo);
		await this.service.deleteConnection(holdingId, tipo, query.confirm === true);
	}

	// ── Día a día ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	@Post(':tipo/sync')
	@HttpCode(202)
	@RequirePermission(EDIT)
	sync(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: SyncDto, @Req() req: IntegrationsRequest) {
		return this.service.adapter(tipo).sync(holdingId, this.actor(req), body ?? {});
	}

	@Get(':tipo/runs')
	runs(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Query() query: RunsQueryDto) {
		return this.service.listRuns(holdingId, tipo, query);
	}

	@Get(':tipo/runs/:id')
	run(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Param('id') id: string) {
		return this.service.getRun(holdingId, tipo, id);
	}

	@Get(':tipo/records')
	records(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Query() query: RecordsQueryDto) {
		return this.service.records(holdingId, tipo, query);
	}

	@Get(':tipo/records/:object/:recordKey/changes')
	recordChanges(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('object') object: string,
		@Param('recordKey') recordKey: string
	) {
		return this.service.recordChanges(holdingId, tipo, object, recordKey);
	}

	@Post(':tipo/records/import')
	@HttpCode(202)
	@RequirePermission(EDIT)
	importRecords(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: ImportRecordsDto, @Req() req: IntegrationsRequest) {
		return this.service.importRecords(holdingId, tipo, body, this.actor(req));
	}

	@Post(':tipo/records/discard')
	@HttpCode(200)
	@RequirePermission(EDIT)
	discard(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: DiscardRecordsDto, @Req() req: IntegrationsRequest) {
		return this.service.discard(holdingId, tipo, body, this.actor(req));
	}

	@Post(':tipo/records/restore')
	@HttpCode(200)
	@RequirePermission(EDIT)
	restore(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: RestoreRecordsDto) {
		return this.service.restore(holdingId, tipo, body);
	}

	// ── Reglas por tipo y de exclusión ──────────────────────────────────────────────────────────────────────────────────────

	@Get(':tipo/settings')
	settings(@HoldingId() holdingId: string, @Param('tipo') tipo: string) {
		return this.service.getSettings(holdingId, tipo);
	}

	@Put(':tipo/settings')
	@RequirePermission(EDIT)
	putSettings(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: SettingsDto, @Req() req: IntegrationsRequest) {
		return this.service.putSettings(holdingId, tipo, body.settings, this.actor(req));
	}

	@Get(':tipo/rules/fields')
	ruleFields(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Query() query: RuleFieldsQueryDto) {
		return this.service.ruleFields(holdingId, tipo, query.object);
	}

	@Get(':tipo/rules')
	rules(@HoldingId() holdingId: string, @Param('tipo') tipo: string) {
		return this.service.getRules(holdingId, tipo);
	}

	@Put(':tipo/rules')
	@RequirePermission(EDIT)
	putRules(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Body() body: RulesDto, @Req() req: IntegrationsRequest) {
		return this.service.putRules(holdingId, tipo, body.rules, this.actor(req));
	}

	// ── Mapeos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	@Get('erp/taxes')
	taxes(@HoldingId() holdingId: string, @Query() query: TaxesQueryDto) {
		return this.service.erp.taxes(holdingId, query);
	}

	@Get(':tipo/mappings/:objeto/options')
	mappingOptions(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Query() query: MappingOptionsQueryDto
	) {
		return this.service.mappingOptions(holdingId, tipo, objeto, query.side ?? 'external', query.search);
	}

	@Get(':tipo/mappings/:objeto')
	mapping(@HoldingId() holdingId: string, @Param('tipo') tipo: string, @Param('objeto') objeto: string, @Query() query: MappingQueryDto) {
		return this.service.getMapping(holdingId, tipo, objeto, query);
	}

	@Put(':tipo/mappings/:objeto')
	@RequirePermission(EDIT)
	async putMapping(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Body() body: PutMappingDto,
		@Req() req: IntegrationsRequest
	) {
		if (objeto === 'fields') await this.service.assertFieldsEditor(holdingId, req.permissionContext);

		return this.service.putMapping(holdingId, tipo, objeto, body.items, this.actor(req));
	}

	@Post(':tipo/mappings/:objeto/accept-suggestions')
	@HttpCode(200)
	@RequirePermission(EDIT)
	acceptSuggestions(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Body() body: AcceptSuggestionsDto,
		@Req() req: IntegrationsRequest
	) {
		return this.service.acceptSuggestions(holdingId, tipo, objeto, body?.keys, this.actor(req));
	}

	@Post(':tipo/mappings/:objeto/not-applicable')
	@HttpCode(200)
	@RequirePermission(EDIT)
	async markNotApplicable(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Body() body: MappingKeysDto,
		@Req() req: IntegrationsRequest
	) {
		if (objeto === 'fields') await this.service.assertFieldsEditor(holdingId, req.permissionContext);

		return this.service.markNotApplicable(holdingId, tipo, objeto, body.keys, this.actor(req));
	}

	@Post(':tipo/mappings/:objeto/restore')
	@HttpCode(200)
	@RequirePermission(EDIT)
	async restoreNotApplicable(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Body() body: MappingKeysDto,
		@Req() req: IntegrationsRequest
	) {
		if (objeto === 'fields') await this.service.assertFieldsEditor(holdingId, req.permissionContext);

		return this.service.restoreNotApplicable(holdingId, tipo, objeto, body.keys, this.actor(req));
	}

	@Delete(':tipo/mappings/:objeto')
	@HttpCode(204)
	@RequirePermission(EDIT)
	async deleteMapping(
		@HoldingId() holdingId: string,
		@Param('tipo') tipo: string,
		@Param('objeto') objeto: string,
		@Query() query: DeleteMappingQueryDto,
		@Req() req: IntegrationsRequest
	): Promise<void> {
		if (objeto === 'fields') await this.service.assertFieldsEditor(holdingId, req.permissionContext);
		await this.service.deleteMapping(holdingId, tipo, objeto, query.sapira_id, query.external_id, query.confirm === true);
	}

	// ── CRM (A5) ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	@Get('crm/stages')
	stages(@HoldingId() holdingId: string) {
		return this.service.crm.stages(holdingId);
	}

	@Post('crm/opportunities/fetch')
	@HttpCode(200)
	@RequirePermission(EDIT)
	fetchOpportunities(@HoldingId() holdingId: string, @Body() body: CrmFetchDto) {
		return this.service.fetchCrmOpportunities(holdingId, body ?? {});
	}

	@Post('crm/opportunities/import')
	@HttpCode(202)
	@RequirePermission(EDIT)
	importOpportunities(@HoldingId() holdingId: string, @Body() body: CrmImportDto) {
		return this.service.crm.importOpportunities(holdingId, body.opportunity_ids, body.mode ?? 'full');
	}
}

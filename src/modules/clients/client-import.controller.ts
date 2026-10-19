import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { ClientImportService } from './client-import.service';
import { ClientImportApplyDto, ClientImportPreviewDto } from './dtos/client-import.dto';

type ImportRequest = { permissionContext?: PermissionContext };
const actorOf = (req: ImportRequest) => ({ userId: String(req.permissionContext?.userId ?? '') });

const ROW_SHAPE =
	'{ row, key, status: updated|unchanged|not_found|ambiguous|failed, client: { id, name } | null, changes: [{ field, from, to }], errors[] }';

/**
 * "Importar para actualizar" clientes comerciales (Domi 19-10). Ruta propia (`clients/import`) para no chocar con `clients/:id`. Todo exige
 * `EDIT_CLIENTES`, también la vista previa: es parte de editar.
 */
@ApiTags('Clients')
@Controller('clients/import')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission('EDIT_CLIENTES')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ClientImportController {
	constructor(private readonly imports: ClientImportService) {}

	@Post('preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: importar para actualizar clientes',
		description: `Body { key_field: client_number|tax_id, fields[] (mapeados), rows[{ row, key, fields{…} }] }. Responde { key_field, fields, counts{ total, updated, unchanged, not_found, ambiguous, failed }, rows[${ROW_SHAPE}] }. Celda vacía = no viaja = no cambia. No escribe`,
	})
	preview(@HoldingId() holdingId: string, @Body() body: ClientImportPreviewDto) {
		return this.imports.preview(holdingId, body);
	}

	@Post()
	@HttpCode(200)
	@ApiOperation({
		summary: 'Importar para actualizar clientes',
		description:
			'Mismo body que la vista previa + label?. Aplica los cambios en una transacción y guarda el lote (import_batches) con el antes/después. Responde { batch_id, created_at, …vista previa }',
	})
	apply(@HoldingId() holdingId: string, @Body() body: ClientImportApplyDto, @Request() req: ImportRequest) {
		return this.imports.apply(holdingId, body, actorOf(req));
	}

	@Get('batches')
	@ApiOperation({
		summary: 'Últimas importaciones de clientes',
		description:
			'[{ id, label, key_field, fields[], rows_total, updated_count, skipped_count, failed_count, created_at, created_by, reverted_at, reverted_by, reverted_summary }]',
	})
	batches(@HoldingId() holdingId: string) {
		return this.imports.batches(holdingId);
	}

	@Post(':batchId/revert')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Revertir una importación',
		description:
			'Restaura el valor anterior de cada campo cuyo valor actual sigue siendo el importado; los editados después quedan (kept_fields). { batch_id, restored_rows, kept_rows, kept_fields }',
	})
	@ApiResponse({ status: 409, description: '{ code: already_reverted }' })
	revert(@HoldingId() holdingId: string, @Param('batchId', new ParseUUIDPipe()) batchId: string, @Request() req: ImportRequest) {
		return this.imports.revert(holdingId, batchId, actorOf(req));
	}
}

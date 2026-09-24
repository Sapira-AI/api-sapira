import { Controller, Get, Param, ParseUUIDPipe, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ClientDocumentsService } from './client-documents.service';

/**
 * Descarga de un documento por id. Excepción documentada a `HoldingScopeGuard` (`autorizacion-y-tenancy.md`): la
 * usan los enlaces guardados en `client_documents.file_url`, también desde la app actual, que no envía el holding.
 * El holding sale del registro y el servicio valida que el usuario pertenezca a él (si no, 404).
 */
@ApiTags('Client documents')
@Controller('client-documents')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class ClientDocumentsController {
	constructor(private readonly documents: ClientDocumentsService) {}

	@Get(':id/download')
	@ApiOperation({ summary: 'URL firmada (60 s) para abrir un documento', description: 'Documentos antiguos: su URL pública' })
	@ApiParam({ name: 'id', type: String })
	async download(@Param('id', new ParseUUIDPipe()) id: string, @Request() req: { user?: { sub?: string; id?: string } }) {
		return { url: await this.documents.downloadUrl(id, String(req.user?.sub ?? req.user?.id ?? '')) };
	}
}

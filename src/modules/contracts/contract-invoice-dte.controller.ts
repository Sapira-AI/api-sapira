import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ContractInvoiceDteService } from './contract-invoice-dte.service';
import {
	ContractExportDetailsDto,
	CreateDebitNoteDto,
	DteDocumentQueryDto,
	InvoiceExportDetailsDto,
	SendDteToReceptorDto,
} from './dtos/contract-invoice-dte.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');
const INVOICE_PARAM = { name: 'invoiceId', type: String, description: 'UUID de la factura' };
const CONTRACT_PARAM = { name: 'id', type: String, description: 'UUID del contrato o su número (ej. CTR-2026-184)' };

/**
 * Documentos tributarios electrónicos (DTE) de las facturas del contrato, con el servicio de facturación electrónica: emitir facturas
 * (33/34/110) y notas (61/56/112/111), consultar su estado en el SII, enviarlas al cliente, descargar el PDF o XML, crear notas de débito
 * y guardar los datos de exportación del contrato y del embarque
 * (`contract-invoice-dte.service.ts`). Holding por `HoldingScopeGuard` + `@HoldingId()`.
 */
@ApiTags('Contracts')
@Controller('contracts')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ContractInvoiceDteController {
	constructor(private readonly contractInvoiceDteService: ContractInvoiceDteService) {}

	@Post(':id/invoices/:invoiceId/emit-dte/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: emitir la factura o nota como documento tributario electrónico (SII)',
		description:
			'Compañías chilenas con facturación electrónica activa y sin ERP. Tipo (33, 34, 61, 56), receptor, líneas y totales en pesos enteros (con la tasa del día si la factura estaba en spot), referencias, bloqueos (no_electronic_invoicing, company_uses_erp, receptor incompleto, fx_rate_missing, original_not_accepted…) y avisos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ invoice, document, blockers[], warnings[], can_apply }' })
	async emitDtePreview(@Param('id') id: string, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.contractInvoiceDteService.previewEmitDte(id, invoiceId, holdingId);
	}

	@Post(':id/invoices/:invoiceId/emit-dte/preview-pdf')
	@HttpCode(200)
	@ApiOperation({
		summary: 'PDF en borrador del documento tributario que se emitiría',
		description:
			'El diseño de la compañía (logo y colores) con los datos de la factura, sin folio ni timbre y con «SIN VALOR TRIBUTARIO». No gasta folio ni escribe nada. Devuelve `{ file_name, content_type, content_base64 }`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	async emitDtePreviewPdf(@Param('id') id: string, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		const document = await this.contractInvoiceDteService.previewDtePdf(id, invoiceId, holdingId);

		return { file_name: document.fileName, content_type: document.contentType, content_base64: document.contenido.toString('base64') };
	}

	@Post(':id/invoices/:invoiceId/emit-dte')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Emitir la factura o nota como documento tributario electrónico (SII)',
		description:
			'Crea el DTE en el servicio de facturación electrónica (idempotente por la factura: un reintento no gasta otro folio), lo envía al SII y deja la factura Emitida con el folio (las notas conservan su estado). Evento INVOICE_ISSUED_DTE. Si el envío al SII falla, responde 409 `dte_not_sent` y la factura queda Por Emitir con su DTE creado: volver a llamar lo termina',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `dte` (id, tipo, folio, track_id, ambiente, status), `event_id`, `invoice`' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]`, o `dte_not_sent`' })
	async emitDte(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDteService.emitDte(id, invoiceId, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/dte-status')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Consultar en el SII el estado del documento tributario de la factura',
		description:
			'Actualiza `dte_status` (enviado, aceptado, reparos, rechazado) y, si queda aceptado o con reparos, envía el documento al cliente (correo de intercambio de la razón social). Evento INVOICE_DTE_STATUS_CHANGED si cambió',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ dte_status, consulted, delivery, invoice }' })
	async refreshDteStatus(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDteService.refreshDteStatus(id, invoiceId, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/dte-send-receptor')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Enviar (o reenviar) el documento tributario al cliente',
		description: '`{ email? }`. Solo con el documento aceptado por el SII. Sin email, al correo de intercambio de la razón social',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ para, sent, invoice }' })
	@ApiResponse({ status: 409, description: 'dte_not_accepted, dte_receptor_without_email, dte_receptor_failed' })
	async sendDteToReceptor(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: SendDteToReceptorDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDteService.sendDteToReceptor(id, invoiceId, holdingId, authIdOf(req), body?.email);
	}

	@Get(':id/invoices/:invoiceId/dte-document')
	@ApiOperation({
		summary: 'PDF (tributario o cedible) o XML del documento tributario de la factura',
		description: '`?format=pdf|xml&copy=tributaria|cedible`. Devuelve `{ file_name, content_type, content_base64 }`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	async dteDocument(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Query() query: DteDocumentQueryDto,
		@HoldingId() holdingId: string
	) {
		const document = await this.contractInvoiceDteService.dteDocument(
			id,
			invoiceId,
			holdingId,
			query.format ?? 'pdf',
			query.copy ?? 'tributaria'
		);

		return { file_name: document.fileName, content_type: document.contentType, content_base64: document.contenido.toString('base64') };
	}

	@Post(':id/invoices/:invoiceId/debit-note/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: nota de débito sobre una factura emitida',
		description:
			'`{ amount, reason }` (neto en moneda de factura). Monto, IVA, total y bloqueos (not_issued, original_not_accepted…). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	async debitNotePreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: CreateDebitNoteDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceDteService.previewDebitNote(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/debit-note')
	@ApiOperation({
		summary: 'Crear una nota de débito sobre una factura emitida',
		description:
			'Una línea con el neto y el motivo, IVA de la factura y referencia CodRef 3. Nace Emitida y pendiente de emisión (se emite como DTE 56 con emit-dte). Evento INVOICE_DEBIT_NOTE_CREATED',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 201, description: 'El preview más `applied`, `debit_note_id`, `event_id`, `invoice` (detalle de la ND)' })
	async createDebitNote(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: CreateDebitNoteDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDteService.createDebitNote(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Patch(':id/export-details')
	@ApiOperation({
		summary: 'Guardar los datos de exportación del contrato',
		description:
			'Para la factura de exportación (DTE 110): servicios o bienes, modalidad y cláusula de venta, forma de pago, vía de transporte, puertos y país de destino, con los códigos de las tablas de Aduana. Todos opcionales; sin campos con valor queda NULL',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ contract_id, export_details }' })
	async updateContractExportDetails(@Param('id') id: string, @Body() body: ContractExportDetailsDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceDteService.updateContractExportDetails(id, holdingId, body);
	}

	@Patch(':id/invoices/:invoiceId/export-details')
	@ApiOperation({
		summary: 'Guardar los datos del embarque de una factura de exportación',
		description:
			'Bultos, pesos, flete, seguro, total de la cláusula y DUS de una factura de bienes, antes de emitirla (Por Emitir sin DTE; 409 `invoice_not_pending` si no). Pisan los del contrato',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ invoice_id, export_details }' })
	async updateInvoiceExportDetails(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: InvoiceExportDetailsDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceDteService.updateInvoiceExportDetails(id, invoiceId, holdingId, body);
	}
}

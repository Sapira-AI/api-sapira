import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CreateDraftInvoiceDTO, CreateDraftInvoiceResponseDTO } from './dtos/odoo.dto';
import { OdooInvoicesService } from './odoo-invoices.service';

@ApiTags('Odoo - Invoices')
@Controller('odoo/invoices')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class OdooInvoicesController {
	constructor(private readonly odooInvoicesService: OdooInvoicesService) {}

	@Post('create-draft')
	@ApiOperation({
		summary: 'Crear factura en borrador en Odoo',
		description:
			'Crea una nueva factura en estado borrador en Odoo con las líneas de productos especificadas. Requiere el header X-Holding-Id para identificar la conexión Odoo.',
	})
	@ApiHeader({
		name: 'X-Holding-Id',
		description: 'ID del holding para identificar la conexión Odoo',
		required: true,
		schema: { type: 'string' },
	})
	@ApiBody({
		type: CreateDraftInvoiceDTO,
		required: true,
		description: 'Datos para crear la factura en borrador',
		examples: {
			'test-invoice-partner-16252': {
				summary: 'Factura de prueba para partner 16252',
				description: 'Ejemplo de factura de prueba para el partner 16252',
				value: {
					partner_id: 16252,
					move_type: 'out_invoice',
					invoice_date: '2026-02-10',
					invoice_date_due: '2026-03-10',
					payment_reference: 'TEST-REF-001',
					invoice_origin: 'TEST-SO-001',
					narration: 'Factura de prueba generada desde API',
					x_sapira_invoice_id: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
					invoice_line_ids: [
						{
							product_id: 1,
							name: 'Producto de prueba 1',
							quantity: 2,
							price_unit: 100.0,
							tax_ids: [1],
							discount: 0,
						},
						{
							product_id: 2,
							name: 'Producto de prueba 2',
							quantity: 1,
							price_unit: 50.0,
							tax_ids: [1],
							discount: 10,
						},
					],
				},
			},
			'minimal-invoice-example': {
				summary: 'Factura mínima (solo campos requeridos)',
				description: 'Ejemplo con solo los campos mínimos necesarios',
				value: {
					partner_id: 16252,
					move_type: 'out_invoice',
					invoice_line_ids: [
						{
							product_id: 1,
							quantity: 1,
							price_unit: 100.0,
						},
					],
				},
			},
		},
	})
	@ApiOkResponse({
		type: CreateDraftInvoiceResponseDTO,
		description: 'Factura en borrador creada exitosamente',
	})
	@ApiBadRequestResponse({ description: 'Parámetros inválidos o error al crear la factura' })
	async createDraftInvoice(
		@Headers('x-holding-id') holdingId: string,
		@Body() invoiceData: CreateDraftInvoiceDTO
	): Promise<CreateDraftInvoiceResponseDTO> {
		const sanitizedHoldingId = Array.isArray(holdingId) ? holdingId[0] : holdingId.split(',')[0].trim();
		return await this.odooInvoicesService.createDraftInvoice(sanitizedHoldingId, invoiceData);
	}
}

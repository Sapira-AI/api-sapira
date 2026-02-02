import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

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
		description: 'Crea una nueva factura en estado borrador en Odoo con las líneas de productos especificadas',
	})
	@ApiBody({
		type: CreateDraftInvoiceDTO,
		required: true,
		description: 'Datos para crear la factura en borrador',
		examples: {
			'create-invoice-example': {
				summary: 'Ejemplo de creación de factura',
				description: 'Ejemplo completo de creación de factura con líneas de productos',
				value: {
					connection_id: 'aisapira_prod',
					partner_id: 123,
					move_type: 'out_invoice',
					invoice_date: '2025-01-15',
					invoice_date_due: '2025-02-15',
					payment_reference: 'REF-2025-001',
					invoice_origin: 'SO-2025-001',
					narration: 'Notas internas de la factura',
					company_id: 1,
					invoice_line_ids: [
						{
							product_id: 456,
							name: 'Producto de ejemplo',
							quantity: 2,
							price_unit: 100.0,
							tax_ids: [1],
							discount: 0,
						},
						{
							product_id: 789,
							quantity: 1,
							price_unit: 50.0,
							tax_ids: [1],
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
	async createDraftInvoice(@Body() invoiceData: CreateDraftInvoiceDTO): Promise<CreateDraftInvoiceResponseDTO> {
		return await this.odooInvoicesService.createDraftInvoice(invoiceData);
	}
}

import { Controller, Get, Headers, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { InvoiceTaxValidationResult, InvoiceTaxValidatorService, TaxMappingValidationResult } from './services/invoice-tax-validator.service';

@ApiTags('Odoo - Invoice Tax Validator')
@Controller('odoo/invoices')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class InvoiceTaxValidatorController {
	constructor(private readonly invoiceTaxValidatorService: InvoiceTaxValidatorService) {}

	@Get('validate-tax-mapping/:odooInvoiceId')
	@ApiOperation({
		summary: 'Validar lógica de mapeo de impuestos contra factura real de Odoo',
		description:
			'Toma una factura YA EMITIDA en Odoo, simula el cálculo de impuestos usando TaxMappingService, ' +
			'y compara los resultados con los tax_ids reales de Odoo. Esto permite validar que la lógica de mapeo ' +
			'replica exactamente el comportamiento nativo de Odoo para diferentes países, clientes y productos.',
	})
	async validateTaxMappingLogic(
		@Headers('x-holding-id') holdingId: string,
		@Param('odooInvoiceId', ParseIntPipe) odooInvoiceId: number
	): Promise<TaxMappingValidationResult> {
		return await this.invoiceTaxValidatorService.validateTaxMappingLogic(odooInvoiceId, holdingId);
	}

	@Get(':invoiceId/validate-taxes')
	@ApiOperation({
		summary: 'Validar impuestos de factura Sapira vs Odoo',
		description:
			'Compara los tax_ids de las líneas de factura entre Sapira y Odoo para verificar que coincidan. ' +
			'Útil para validar que el mapeo de posiciones fiscales funciona correctamente.',
	})
	async validateInvoiceTaxes(
		@Headers('x-holding-id') holdingId: string,
		@Param('invoiceId') invoiceId: string
	): Promise<InvoiceTaxValidationResult> {
		return await this.invoiceTaxValidatorService.validateInvoiceTaxes(invoiceId, holdingId);
	}
}

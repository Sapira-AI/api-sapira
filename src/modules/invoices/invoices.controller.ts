import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BulkUpdateCurrencyResponseDto } from './dtos/bulk-update-currency-response.dto';
import { BulkUpdateCurrencyDto } from './dtos/bulk-update-currency.dto';
import { RecalculateTaxesBatchDto, RecalculateTaxesBatchResponseDto, RecalculateTaxesResponseDto } from './dtos/recalculate-taxes.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@Controller('invoices')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class InvoicesController {
	constructor(private readonly invoicesService: InvoicesService) {}

	@Post('bulk-update-currency')
	@ApiOperation({
		summary: 'Actualización masiva de moneda de facturación',
		description:
			'Actualiza la moneda de facturación de múltiples facturas en estado "Por Emitir". ' +
			'Si la nueva moneda difiere de la moneda del contrato, intenta obtener el tipo de cambio automáticamente ' +
			'desde el sistema de exchange rates. Si no hay tipo de cambio disponible, los montos se dejan en NULL ' +
			'para ingreso manual posterior. Soporta modo dryRun para simular cambios sin aplicarlos.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Actualización completada exitosamente',
		type: BulkUpdateCurrencyResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos inválidos o facturas no en estado "Por Emitir"',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'No autenticado',
	})
	@HttpCode(HttpStatus.OK)
	async bulkUpdateCurrency(@Body() dto: BulkUpdateCurrencyDto): Promise<BulkUpdateCurrencyResponseDto> {
		return this.invoicesService.bulkUpdateCurrency(dto);
	}

	@Patch(':id/auto-invoice')
	@ApiOperation({
		summary: 'Actualizar auto_invoice de una factura individual',
		description:
			'Actualiza el campo auto_invoice de una factura específica. Cuando auto_invoice es true, la factura se enviará a Odoo con auto_post configurado para emisión automática.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Campo auto_invoice actualizado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Factura no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async updateAutoInvoice(@Param('id') invoiceId: string, @Body() body: { auto_invoice: boolean }): Promise<{ success: boolean; message: string }> {
		await this.invoicesService.updateAutoInvoice(invoiceId, body.auto_invoice);
		return {
			success: true,
			message: `auto_invoice actualizado a ${body.auto_invoice}`,
		};
	}

	@Patch('contract/:contractId/bulk-auto-invoice')
	@ApiOperation({
		summary: 'Actualizar auto_invoice masivamente por contrato',
		description: 'Actualiza el campo auto_invoice de todas las facturas "Por Emitir" que no han sido enviadas a Odoo de un contrato específico.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Facturas actualizadas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async bulkUpdateAutoInvoice(
		@Param('contractId') contractId: string,
		@Body() body: { auto_invoice: boolean }
	): Promise<{ success: boolean; message: string; updated_count: number }> {
		const count = await this.invoicesService.bulkUpdateAutoInvoiceByContract(contractId, body.auto_invoice);
		return {
			success: true,
			message: `${count} facturas actualizadas`,
			updated_count: count,
		};
	}

	@Post(':id/recalculate-taxes')
	@ApiOperation({
		summary: 'Recalcular impuestos de una factura con retenciones de Colombia',
		description:
			'Recalcula los campos de impuestos (vat, tax_amount_*) de una factura aplicando las retenciones fiscales ' +
			'de Colombia (ReteICA, Retefuente, ReteIVA) configuradas en el cliente. Solo funciona para facturas en estado "Por Emitir".',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Impuestos recalculados exitosamente',
		type: RecalculateTaxesResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Factura no válida para recálculo (debe estar en estado "Por Emitir")',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Factura o cliente no encontrado',
	})
	@HttpCode(HttpStatus.OK)
	async recalculateTaxes(@Param('id') invoiceId: string): Promise<RecalculateTaxesResponseDto> {
		return this.invoicesService.recalculateInvoiceTaxes(invoiceId);
	}

	@Post('recalculate-taxes-batch')
	@ApiOperation({
		summary: 'Recalcular impuestos de múltiples facturas en batch',
		description:
			'Recalcula los impuestos de múltiples facturas aplicando retenciones de Colombia. ' +
			'Útil para actualizar todas las facturas pendientes de un contrato.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Recálculo batch completado',
		type: RecalculateTaxesBatchResponseDto,
	})
	@HttpCode(HttpStatus.OK)
	async recalculateTaxesBatch(@Body() dto: RecalculateTaxesBatchDto): Promise<RecalculateTaxesBatchResponseDto> {
		return this.invoicesService.recalculateTaxesBatch(dto);
	}
}

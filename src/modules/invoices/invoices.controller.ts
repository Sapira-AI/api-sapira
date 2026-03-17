import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BulkUpdateCurrencyResponseDto } from './dtos/bulk-update-currency-response.dto';
import { BulkUpdateCurrencyDto } from './dtos/bulk-update-currency.dto';
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
}

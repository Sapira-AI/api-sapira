import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
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
}

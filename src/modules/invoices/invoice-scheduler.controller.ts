import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ProcessInvoicesResponseDto, SchedulerStatusDto, SendInvoicesDto } from './dtos/send-invoices.dto';
import { InvoiceSchedulerService } from './invoice-scheduler.service';

@ApiTags('Invoices - Scheduler')
@Controller('invoices/scheduler')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class InvoiceSchedulerController {
	constructor(private readonly invoiceSchedulerService: InvoiceSchedulerService) {}

	@Post('send')
	@ApiOperation({
		summary: 'Enviar facturas pendientes a Odoo',
		description:
			'Procesa y envía facturas con issue_date <= hoy y status "Por Emitir" a Odoo. ' +
			'Por defecto ejecuta en modo dryRun para evitar envíos accidentales.',
	})
	@ApiHeader({
		name: 'X-Holding-Id',
		description: 'ID del holding (opcional, si no se envía procesa todos los holdings)',
		required: false,
	})
	@ApiOkResponse({
		type: ProcessInvoicesResponseDto,
		description: 'Resultado del procesamiento de facturas',
	})
	async sendInvoices(@Headers('x-holding-id') holdingId: string | undefined, @Body() dto: SendInvoicesDto): Promise<ProcessInvoicesResponseDto> {
		const sanitizedHoldingId = holdingId ? (Array.isArray(holdingId) ? holdingId[0] : holdingId.split(',')[0].trim()) : undefined;

		return await this.invoiceSchedulerService.processInvoicesToSend({
			dryRun: dto.dryRun ?? true,
			holdingId: sanitizedHoldingId,
			contractId: dto.contractId,
		});
	}

	@Get('status')
	@ApiOperation({
		summary: 'Ver estado del scheduler',
		description: 'Obtiene información sobre la configuración del scheduler de facturas',
	})
	@ApiOkResponse({
		type: SchedulerStatusDto,
		description: 'Estado actual del scheduler',
	})
	async getSchedulerStatus(): Promise<SchedulerStatusDto> {
		return {
			enabled: process.env.INVOICE_SCHEDULER_ENABLED !== 'false',
			scheduledHour: parseInt(process.env.INVOICE_SCHEDULER_HOUR || '9', 10),
			isRunning: false,
		};
	}

	@Get('debug/:invoiceId')
	@ApiOperation({
		summary: 'Debug de factura específica',
		description: 'Verifica por qué una factura no está siendo procesada por el scheduler',
	})
	async debugInvoice(@Param('invoiceId') invoiceId: string): Promise<any> {
		return await this.invoiceSchedulerService.debugInvoice(invoiceId);
	}

	@Get('debug-today')
	@ApiOperation({
		summary: 'Debug de todas las facturas de hoy',
		description: 'Analiza todas las facturas con issue_date de hoy y muestra cuáles se procesarían y cuáles no, con sus razones',
	})
	@ApiHeader({
		name: 'X-Holding-Id',
		description: 'ID del holding (opcional, si no se envía analiza todos los holdings)',
		required: false,
	})
	async debugInvoicesToday(@Headers('x-holding-id') holdingId: string | undefined): Promise<any> {
		const sanitizedHoldingId = holdingId ? (Array.isArray(holdingId) ? holdingId[0] : holdingId.split(',')[0].trim()) : undefined;
		return await this.invoiceSchedulerService.debugInvoicesToday(sanitizedHoldingId);
	}
}

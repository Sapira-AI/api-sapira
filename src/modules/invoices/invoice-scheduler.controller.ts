import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SchedulerJobListItemDto, SchedulerJobStatusDto, StartSchedulerJobResponseDto } from './dtos/scheduler-job.dto';
import { SchedulerStatusDto, SendInvoicesDto } from './dtos/send-invoices.dto';
import { InvoiceSchedulerService } from './invoice-scheduler.service';

@ApiTags('Invoices - Scheduler')
@Controller('invoices/scheduler')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class InvoiceSchedulerController {
	constructor(private readonly invoiceSchedulerService: InvoiceSchedulerService) {}

	@Post('send')
	@ApiOperation({
		summary: 'Iniciar job de envío de facturas a Odoo (asíncrono)',
		description:
			'Inicia un job asíncrono que procesa y envía facturas con issue_date <= hoy y status "Por Emitir" a Odoo. ' +
			'Retorna inmediatamente con un jobId para consultar el progreso. ' +
			'Por defecto ejecuta en modo dryRun para evitar envíos accidentales.',
	})
	@ApiHeader({
		name: 'X-Holding-Id',
		description: 'ID del holding (opcional, si no se envía procesa todos los holdings)',
		required: false,
	})
	@ApiOkResponse({
		type: StartSchedulerJobResponseDto,
		description: 'Job iniciado exitosamente',
	})
	async sendInvoices(
		@Headers('x-holding-id') holdingId: string | undefined,
		@Body() dto: SendInvoicesDto,
		@Req() req: any
	): Promise<StartSchedulerJobResponseDto> {
		const sanitizedHoldingId = holdingId ? (Array.isArray(holdingId) ? holdingId[0] : holdingId.split(',')[0].trim()) : undefined;
		const userId = req.user?.sub || req.user?.id || 'unknown';

		const jobId = await this.invoiceSchedulerService.startSchedulerJob({
			dryRun: dto.dryRun ?? true,
			holdingId: sanitizedHoldingId,
			contractId: dto.contractId,
			userId,
		});

		return {
			jobId,
			message: 'Scheduler job iniciado exitosamente',
			dryRun: dto.dryRun ?? true,
		};
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

	@Get('job/:jobId')
	@ApiOperation({
		summary: 'Consultar estado de un job',
		description: 'Obtiene el estado actual de un job de scheduler, incluyendo progreso y resultado',
	})
	@ApiOkResponse({
		type: SchedulerJobStatusDto,
		description: 'Estado del job',
	})
	async getJobStatus(@Param('jobId') jobId: string): Promise<SchedulerJobStatusDto | null> {
		const job = await this.invoiceSchedulerService.getJobStatus(jobId);

		if (!job) {
			return null;
		}

		return {
			jobId: job.jobId,
			status: job.status,
			progress: job.progress,
			result: job.result,
			error: job.error,
			dryRun: job.dryRun,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
		};
	}

	@Get('jobs')
	@ApiOperation({
		summary: 'Listar jobs recientes',
		description: 'Obtiene los jobs recientes del usuario actual',
	})
	@ApiHeader({
		name: 'X-Holding-Id',
		description: 'ID del holding',
		required: true,
	})
	@ApiOkResponse({
		type: [SchedulerJobListItemDto],
		description: 'Lista de jobs recientes',
	})
	async getRecentJobs(@Headers('x-holding-id') holdingId: string, @Req() req: any): Promise<SchedulerJobListItemDto[]> {
		const sanitizedHoldingId = holdingId ? (Array.isArray(holdingId) ? holdingId[0] : holdingId.split(',')[0].trim()) : 'all';
		const userId = req.user?.sub || req.user?.id || 'unknown';

		const jobs = await this.invoiceSchedulerService.getRecentJobs(sanitizedHoldingId, userId, 10);

		return jobs.map((job) => ({
			jobId: job.jobId,
			status: job.status,
			dryRun: job.dryRun,
			contractId: job.contractId,
			progress: job.progress,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
		}));
	}
}

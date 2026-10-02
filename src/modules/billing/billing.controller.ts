import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Request, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { BillingBulkService } from './billing-bulk.service';
import { BillingCollectionsService } from './billing-collections.service';
import { BillingExportService } from './billing-export.service';
import { BillingPaymentsService } from './billing-payments.service';
import { BILLING_PERMISSIONS, BillingPermissionGuard, RequireBillingPermission } from './billing-permissions.service';
import { BillingReadService } from './billing-read.service';
import { EMAIL_STATUSES } from './billing-states';
import {
	BillingAgingQueryDto,
	BillingCalendarQueryDto,
	BillingCreditNotesQueryDto,
	BillingExportQueryDto,
	BillingFiltersDto,
	BillingInvoicesQueryDto,
	BillingSubscriptionInvoicesQueryDto,
	BillingToIssueQueryDto,
	CollectionDto,
	CollectionSettingsDto,
	ProformaDto,
	RegisterPaymentDto,
	ToIssueErpResetDto,
	ToIssueFxDto,
	ToIssueRescheduleDto,
	ToIssueSendNowDto,
	VoidPaymentDto,
} from './dtos/billing.dto';

import type { Response } from 'express';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');
const INVOICE_PARAM = { name: 'invoiceId', description: 'UUID de la factura' };
const FAN_OUT =
	'{ bulk_id, operation, preview, contracts, results[{ invoice_id, invoice_number, contract_id, ok, blockers[{ code, message, next_step, action }], warnings[], message? }], summary{ ok, failed } }';

/**
 * Facturación v2 (`docs/v2-rediseno/spec-facturacion-v2.md` §5, mapa `mapa-v2-facturacion.md`): vista por holding (lista, KPIs, cola Por
 * emitir, NC, antigüedad AR, export), pagos y correos. Toda operación sobre una factura se hace en su contrato (single path): las rutas
 * `to-issue/*` solo agrupan por contrato y llaman al servicio del 360. Holding por `HoldingScopeGuard` + `@HoldingId()`.
 */
@ApiTags('Billing')
@Controller('billing')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, BillingPermissionGuard)
@RequireBillingPermission(BILLING_PERMISSIONS.view)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class BillingController {
	constructor(
		private readonly read: BillingReadService,
		private readonly payments: BillingPaymentsService,
		private readonly collections: BillingCollectionsService,
		private readonly bulk: BillingBulkService,
		private readonly exporter: BillingExportService
	) {}

	// ---------------------------------------------------------------- lecturas

	@Get('filters')
	@ApiOperation({
		summary: 'Catálogos de filtros',
		description: 'Compañías, clientes, razones sociales, monedas y contratos con facturas; enums de estados',
	})
	async filters(@HoldingId() holdingId: string) {
		return await this.read.filters(holdingId);
	}

	@Get('invoices')
	@ApiOperation({
		summary: 'Facturas y NC del holding',
		description: 'Paginado con estados derivados (documento, ERP, emisión electrónica, pago), saldo y bloqueos de las Por Emitir',
	})
	@ApiResponse({ status: 200, description: '{ data[fila], total, items, currentPage, pages, limit }' })
	async invoices(@Query() query: BillingInvoicesQueryDto, @HoldingId() holdingId: string) {
		return await this.read.invoices(holdingId, query);
	}

	@Get('invoices/summary')
	@ApiOperation({
		summary: 'KPIs',
		description:
			'Por moneda de factura y en moneda del sistema (filas sin conversión aparte): facturado, NC, neto, por emitir, por cobrar, vencido, cobrado',
	})
	async summary(@Query() query: BillingFiltersDto, @HoldingId() holdingId: string) {
		return await this.read.summary(holdingId, query);
	}

	@Get('invoices/export')
	@ApiOperation({ summary: 'Exportar XLSX', description: 'Vista filtrada completa (sin corte); detail=header|lines' })
	async export(@Query() query: BillingExportQueryDto, @HoldingId() holdingId: string, @Res() res: Response): Promise<void> {
		await this.exporter.stream(holdingId, query, res);
	}

	@Get('invoices/:invoiceId')
	@ApiParam(INVOICE_PARAM)
	@ApiOperation({
		summary: 'Una factura',
		description:
			'Misma fila que la lista + blocked_reasons, to_issue_group, related_documents y payments_summary{ total, paid, balance, payment_state, payments_count, voided_count, last_payment_date }; 404 si no es del holding',
	})
	async invoice(@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.read.invoice(holdingId, invoiceId);
	}

	@Get('invoices/:invoiceId/payments')
	@ApiParam(INVOICE_PARAM)
	@ApiOperation({
		summary: 'Pagos de una factura',
		description: '{ invoice{ total, paid, balance, payment_state }, payments[] } (incluye anulados con confirmed=false)',
	})
	async invoicePayments(@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.read.invoicePayments(holdingId, invoiceId);
	}

	@Get('invoices/:invoiceId/emails')
	@ApiParam(INVOICE_PARAM)
	@ApiOperation({
		summary: 'Correos de una factura',
		description: `Proforma, cobro y recordatorios (\`invoice_emails\` + \`invoice_collection_logs\`): [{ id, kind: proforma|invoice|reminder|collection, recipients[], subject, sent_by{ id, name }, sent_at, status: ${EMAIL_STATUSES.join('|')} }]`,
	})
	@ApiResponse({ status: 200, description: `status normalizado a ${EMAIL_STATUSES.join(' | ')} (desconocido → sent)` })
	async invoiceEmails(@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.read.invoiceEmails(holdingId, invoiceId);
	}

	@Get('to-issue')
	@ApiOperation({
		summary: 'Cola Por emitir',
		description:
			'Por Emitir hasta `until` con bloqueos y grupo (ready, blocked, late, erp_draft) + conteos por grupo y código y `groups.amount_invoice_currency_by_currency{ <grupo>: [{ currency, amount, invoices, unvalued }] }`',
	})
	async toIssue(@Query() query: BillingToIssueQueryDto, @HoldingId() holdingId: string) {
		return await this.read.toIssue(holdingId, query);
	}

	@Get('credit-notes')
	@ApiOperation({
		summary: 'Notas de crédito',
		description: 'NC/ND con la factura acreditada, tipo, motivo y emisión electrónica; `counts.pending_emission`',
	})
	async creditNotes(@Query() query: BillingCreditNotesQueryDto, @HoldingId() holdingId: string) {
		return await this.read.creditNotes(holdingId, query);
	}

	@Get('receivables/aging')
	@ApiOperation({
		summary: 'Antigüedad de cuentas por cobrar',
		description:
			'Por moneda y por cliente: no vencido, 1-30, 31-60, 61-90, 90+, sin vencimiento. `buckets` = montos, `bucket_counts` = n° de facturas por tramo; por cliente y moneda además `total_system`, `unconverted`, `last_payment_date`, `max_days_overdue`, `avg_days_overdue` (ponderado por saldo vencido); `system{ currency, buckets, total, unconverted }`; con `detail=invoices`, `invoices[]` (una fila por factura con saldo, días de atraso, tramo y último pago); `warnings[paid_without_full_payments]`',
	})
	async aging(@Query() query: BillingAgingQueryDto, @HoldingId() holdingId: string) {
		return await this.read.aging(holdingId, query);
	}

	@Get('subscription-invoices')
	@ApiOperation({
		summary: 'Facturas de suscripción (Stripe)',
		description:
			'Solo lectura: filas de la lista + `subscription_external_id`, `plan` (productos de las líneas), `period_start`/`period_end`, `charge_state` (paid|open|failed|refunded|void), `charge_attempts`, `stripe_id`, `document_url` (hosted_invoice_url o invoice_pdf de Stripe). Filtros comunes + `charge_state`; `counts` por estado del cobro',
	})
	async subscriptionInvoices(@Query() query: BillingSubscriptionInvoicesQueryDto, @HoldingId() holdingId: string) {
		return await this.read.subscriptionInvoices(holdingId, query);
	}

	@Get('calendar')
	@ApiOperation({
		summary: 'Calendario de facturación',
		description:
			'Filas = clientes (`group_by=client`) o contratos × columnas = meses, semanas o días (`granularity`, rango `start`/`end`, máx. 24 meses, 26 semanas o 62 días). `scope=invoices`: todas las facturas de los filtros por emisión (o vencimiento con `date_field=due`), estado `to_issue|issued|overdue|paid|credit_note|cancelled`; `scope=to_issue`: la cola Por emitir con estado = grupo y columna `before` para las atrasadas. Respuesta `{ periods[{ key, start, end, kind? }], rows[{ key, client_id, client_name, contract_id, contract_number, cells{ <key>: { invoices, by_currency[{ currency, amount, invoices }], system, unconverted, by_state, items[≤20] } }, totals }], totals{ <key>: … }, grand_total, currency, today, truncated }`',
	})
	async calendar(@Query() query: BillingCalendarQueryDto, @HoldingId() holdingId: string) {
		return await this.read.calendar(holdingId, query);
	}

	@Get('collection-settings')
	@ApiOperation({
		summary: 'Configuración de recordatorios',
		description: 'Fila de `invoice_collection_settings` o defaults (apagado) con `exists: false`',
	})
	async collectionSettings(@HoldingId() holdingId: string) {
		return await this.collections.settings(holdingId);
	}

	// ---------------------------------------------------------------- pagos

	@Post('payments/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Vista previa: registrar pago', description: 'Bloqueos por factura y estado antes/después; no escribe' })
	async paymentPreview(@Body() body: RegisterPaymentDto, @HoldingId() holdingId: string) {
		return await this.payments.preview(holdingId, body);
	}

	@Post('payments')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiOperation({ summary: 'Registrar pago', description: 'Todo o nada; 409 `code: blocked` con `blockers[]` y `preview`' })
	async registerPayment(@Body() body: RegisterPaymentDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.payments.register(holdingId, body, authIdOf(req));
	}

	@Post('payments/:paymentId/void')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam({ name: 'paymentId', description: 'UUID del pago' })
	@ApiOperation({
		summary: 'Anular registro de pago',
		description: 'confirmed = false (nunca DELETE), estado recalculado, evento INVOICE_PAYMENT_VOIDED',
	})
	async voidPayment(
		@Param('paymentId', new ParseUUIDPipe()) paymentId: string,
		@Body() body: VoidPaymentDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.payments.void(holdingId, paymentId, body, authIdOf(req));
	}

	// ---------------------------------------------------------------- correos

	@Post('invoices/:invoiceId/proforma')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam(INVOICE_PARAM)
	@ApiOperation({
		summary: 'Enviar proforma',
		description: 'Correo con el resumen de la factura (datos del 360) y el PDF del front adjunto si viene; fila en invoice_emails',
	})
	async proforma(
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: ProformaDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.collections.proforma(holdingId, invoiceId, body, authIdOf(req));
	}

	@Post('collections/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: correo de cobro',
		description:
			'Un correo por cliente con destinatarios, asunto y cuerpo; `skipped` con motivo; `totals_by_currency[{ currency, amount, invoices }]`',
	})
	async collectionPreview(@Body() body: CollectionDto, @HoldingId() holdingId: string) {
		return await this.collections.previewCollection(holdingId, body);
	}

	@Post('collections')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({
		summary: 'Enviar correo de cobro',
		description: '{ bulk_id, sent[], failed[], skipped[], warnings[] }; log en invoice_collection_logs',
	})
	async collection(@Body() body: CollectionDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.collections.sendCollection(holdingId, body, authIdOf(req));
	}

	@Put('collection-settings')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiOperation({ summary: 'Guardar configuración de recordatorios', description: 'Upsert por holding; variables de plantilla validadas' })
	async saveCollectionSettings(@Body() body: CollectionSettingsDto, @HoldingId() holdingId: string) {
		return await this.collections.saveSettings(holdingId, body);
	}

	// ---------------------------------------------------------------- fan-out Por emitir (servicios del contrato)

	@Post('to-issue/send-now/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Vista previa: enviar al ERP (varias, entre contratos)', description: FAN_OUT })
	async sendNowPreview(@Body() body: ToIssueSendNowDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.sendNow(holdingId, body, authIdOf(req), true);
	}

	@Post('to-issue/send-now')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Enviar al ERP (varias, entre contratos)', description: FAN_OUT })
	async sendNow(@Body() body: ToIssueSendNowDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.sendNow(holdingId, body, authIdOf(req), false);
	}

	@Post('to-issue/reschedule/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Vista previa: reprogramar (varias, entre contratos)', description: FAN_OUT })
	async reschedulePreview(@Body() body: ToIssueRescheduleDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.reschedule(holdingId, body, authIdOf(req), true);
	}

	@Post('to-issue/reschedule')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Reprogramar (varias, entre contratos)', description: FAN_OUT })
	async reschedule(@Body() body: ToIssueRescheduleDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.reschedule(holdingId, body, authIdOf(req), false);
	}

	@Post('to-issue/fx/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Vista previa: tipo de cambio (varias, entre contratos)', description: FAN_OUT })
	async fxPreview(@Body() body: ToIssueFxDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.fx(holdingId, body, authIdOf(req), true);
	}

	@Post('to-issue/fx')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Tipo de cambio (varias, entre contratos)', description: FAN_OUT })
	async fx(@Body() body: ToIssueFxDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.fx(holdingId, body, authIdOf(req), false);
	}

	@Post('to-issue/erp-reset')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Restablecer borrador del ERP (varias, entre contratos)', description: FAN_OUT })
	async erpReset(@Body() body: ToIssueErpResetDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.erpReset(holdingId, body, authIdOf(req));
	}
}

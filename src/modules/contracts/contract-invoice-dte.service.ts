import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { ExchangeRatesService } from '@/modules/banco-central/services/exchange-rates.service';
import { FacturaClientService } from '@/modules/factura/factura-client.service';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';

import { setApiWriter } from './api-writer';
import { invoiceTermsSql, mirrorInvoiceSystemAmounts, refreshInvoiceSystemAmounts } from './api-written-fields';
import { round2 } from './billing-engine';
import { creditNotePendingEmission, PENDING_STATUS } from './contract-360';
import { insertCreditNoteReference } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import {
	commonBlockers,
	type ContractInvoiceContext,
	type ContractInvoiceRow,
	DTE_IN_PROGRESS_CODE,
	erpDraftBlocker,
	fixedFxLines,
	INVOICE_EVENT_TYPES,
	type InvoiceBlocker,
	invoiceDueDate,
	isMultiCurrency,
	ISSUED_STATUS,
	partialBillingBlocker,
	round6,
} from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService } from './contracts.service';
import {
	asReissued,
	type DebitNoteOriginal,
	type DebitNotePlan,
	distributeTax,
	DTE_TYPE_LABELS,
	DTE_TYPES,
	DTE_VALID_STATUSES,
	dteAmounts,
	type DteAmounts,
	dteExportAmounts,
	type DteExportInput,
	type DteOriginal,
	type DteReceptor,
	dteReferencesOf,
	type DteSourceLine,
	type DteStatus,
	dteStatusFromResultado,
	type DteTipo,
	type EmitDtePlan,
	EXPORT_CURRENCIES,
	isDteRejected,
	isExportDte,
	mapInvoiceToDteBody,
	planDebitNote,
	planEmitDte,
	receptorEmailOf,
	roundTo,
} from './invoice-dte';

import type { ContractExportDetailsDto, CreateDebitNoteDto, InvoiceExportDetailsDto } from './dtos/contract-invoice-dte.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Línea de la factura con lo que lleva el DTE (las que viajarían al ERP: visibles y con cantidad). */
interface DteLineRow {
	id: string;
	description: string | null;
	quantity: number;
	unit_of_measure: string | null;
	unit_price_contract_currency: number;
	subtotal_contract_currency: number;
	tax_amount_contract_currency: number;
	total_contract_currency: number;
	unit_price_invoice_currency: number | null;
	subtotal_invoice_currency: number | null;
	tax_amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
	created_at: string | null;
}

/** Todo lo que se necesita para emitir una factura o nota: plan, montos en pesos y cuerpo del DTE. */
interface DtePreparation {
	invoice: ContractInvoiceRow;
	context: ContractInvoiceContext;
	plan: EmitDtePlan;
	receptor: DteReceptor | null;
	original: DteOriginal | null;
	lines: DteLineRow[];
	/** Tasa contrato → factura con que se valoriza (spot: la oficial del día; fija: la de la factura); null en misma moneda. */
	fx: number | null;
	/** La tasa se escribe en la factura y sus líneas (estaba en spot). */
	valuate: boolean;
	/** Día de la tasa oficial usada (spot); null con la tasa fija de la factura o sin conversión. */
	fxDate: string | null;
	amounts: DteAmounts | null;
	body: Record<string, unknown> | null;
	issue_date: string;
	note: boolean;
	/** Documento de exportación (110, 111, 112): moneda y equivalente en pesos. */
	exportacion: DteExportInput | null;
}

/**
 * Emisión de facturas y notas del contrato como documentos tributarios electrónicos (DTE) del SII, con el servicio de facturación
 * electrónica (api-factura), para las compañías chilenas con facturación electrónica activa y sin ERP (un emisor por compañía). Diseño:
 * `front-lenosoft/app/docs/content/api-factura/proyecto/diseno-facturacion-sapira.md`; lógica pura en `invoice-dte.ts`.
 *
 * Emitir: (1) plan y montos en pesos enteros; (2) `createDte` con `externalRef = invoice.id` (idempotente: un reintento devuelve el mismo
 * DTE sin gastar otro folio) y se guarda el vínculo (`dte_status = creado`); (3) `sendDte` al SII y la factura pasa a Emitida con el
 * folio en `invoice_number` (evento `INVOICE_ISSUED_DTE`). Si el envío falla, la factura queda Por Emitir con su DTE creado y «Emitir»
 * lo termina. El estado en el SII se consulta a pedido o por el job horario; aceptado o con reparos, el DTE se envía al receptor.
 */
@Injectable()
export class ContractInvoiceDteService {
	private readonly logger = new Logger(ContractInvoiceDteService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService,
		private readonly factura: FacturaClientService,
		private readonly exchangeRates: ExchangeRatesService
	) {}

	// ---------------------------------------------------------------- emitir

	async previewEmitDte(idOrNumber: string, invoiceId: string, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);

		return this.preview(await this.prepare(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today)));
	}

	async emitDte(idOrNumber: string, invoiceId: string, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const prepared = await this.prepare(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today));

		if (!prepared.plan.can_apply || !prepared.body || !prepared.amounts || !prepared.plan.tipo) {
			throw this.blocked(prepared.plan.blockers, this.preview(prepared));
		}
		const companyId = prepared.invoice.company_id!;

		// (2) Crear el DTE: idempotente por la factura (un reintento devuelve el mismo documento y folio).
		// Reemisión: api-factura archiva el rechazado y emite uno nuevo con otro folio (sin la opción devolvería el rechazado).
		const reissue = prepared.plan.reissue;
		const created = await this.factura.crearDte(companyId, prepared.body, prepared.invoice.id, { reemitirRechazado: reissue });

		await this.transaction(contract.id, holdingId, async (runner) => {
			// En una reemisión la factura vuelve a Por Emitir sin el folio rechazado (las notas conservan su estado) y se limpia lo del DTE
			// anterior: si el envío falla, queda como cualquier emisión a medio terminar y «Terminar emisión» la completa.
			await runner.query(
				`UPDATE invoices SET dte_id = $3, dte_tipo = $4, dte_folio = $5, dte_environment = $6, dte_status = 'creado', dte_status_at = now()${
					reissue
						? `, invoice_number = NULL, dte_track_id = NULL, dte_status_detail = NULL, dte_receptor_email = NULL, dte_receptor_sent_at = NULL,
					dte_receptor_error = NULL${prepared.note ? '' : `, status = '${PENDING_STATUS}'`}`
						: ''
				}
				WHERE id = $1 AND holding_id = $2 AND (dte_id IS NULL OR dte_id = $3${reissue ? ` OR dte_status = 'rechazado'` : ''})`,
				[prepared.invoice.id, holdingId, created.id, created.tipoDte, created.folio, created.ambiente]
			);
		});

		// (3) Enviar al SII. Si falla, la factura queda Por Emitir con su DTE creado: «Emitir» de nuevo lo termina.
		let trackId: string;

		try {
			trackId = (await this.factura.enviarDte(companyId, created.id)).trackId;
		} catch (error) {
			this.logger.warn(
				`DTE ${created.id} (folio ${created.folio}) de la factura ${prepared.invoice.id} creado pero no enviado: ${errorText(error)}`
			);
			throw new ConflictException({
				message: `El documento tributario quedó creado con el folio ${created.folio}, pero no se pudo enviar al SII: ${errorText(error)}. Vuelve a usar «Emitir» para terminar de enviarlo`,
				code: 'dte_not_sent',
				dte: { id: created.id, folio: created.folio },
			});
		}

		const eventId = await this.transaction(contract.id, holdingId, async (runner) => {
			await this.applyIssued(runner, prepared, holdingId, created, trackId);

			return this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.dte_issued,
				title: `${DTE_TYPE_LABELS[created.tipoDte] ?? 'Documento tributario'} N° ${created.folio} ${reissue ? 'reemitida' : 'emitida'}`,
				description: `${
					reissue
						? `Reemitida porque el SII rechazó el documento N° ${prepared.invoice.invoice_number ?? prepared.invoice.dte_folio ?? '—'}. `
						: ''
				}Emitida como documento tributario electrónico (folio ${created.folio}, TrackId ${trackId}) el ${prepared.issue_date}${
					prepared.amounts
						? prepared.exportacion && prepared.exportacion.currency !== 'CLP'
							? ` por ${prepared.amounts.total.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${prepared.exportacion.currency}`
							: ` por $${prepared.amounts.total.toLocaleString('es-CL')}`
						: ''
				}`,
				effective_date: prepared.issue_date,
				invoice_id: prepared.invoice.id,
				metadata: {
					dte_id: created.id,
					dte_tipo: created.tipoDte,
					folio: created.folio,
					track_id: trackId,
					ambiente: created.ambiente,
					retry: prepared.plan.retry || created.existente,
					reissue: reissue ? { rejected_dte_id: prepared.invoice.dte_id, rejected_folio: prepared.invoice.dte_folio ?? null } : null,
					before: {
						status: prepared.invoice.status,
						invoice_number: prepared.invoice.invoice_number,
						issue_date: prepared.invoice.issue_date,
					},
					amounts: prepared.amounts
						? { neto: prepared.amounts.neto, exento: prepared.amounts.exento, iva: prepared.amounts.iva, total: prepared.amounts.total }
						: null,
					fx: prepared.fx,
					valuated: prepared.valuate,
					export: prepared.exportacion ? { currency: prepared.exportacion.currency, clp_rate: prepared.exportacion.clp_rate } : null,
					warnings: prepared.plan.warnings.map((warning) => warning.code),
				},
			});
		});

		return {
			...this.preview(prepared),
			applied: true,
			dte: {
				id: created.id,
				tipo: created.tipoDte,
				folio: created.folio,
				track_id: trackId,
				ambiente: created.ambiente,
				status: 'enviado' as DteStatus,
			},
			event_id: eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, prepared.invoice.id, holdingId),
		};
	}

	/**
	 * PDF en borrador del documento que se emitiría (el mismo cuerpo de «Emitir»): el diseño de la compañía con su logo y colores, sin
	 * folio ni timbre y con «SIN VALOR TRIBUTARIO». Se puede ver aunque haya bloqueos (p. ej. para revisar cómo queda); no escribe nada.
	 */
	async previewDtePdf(idOrNumber: string, invoiceId: string, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const prepared = await this.prepare(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today));

		if (!prepared.body || !prepared.invoice.company_id) throw this.blocked(prepared.plan.blockers, this.preview(prepared));

		return this.factura.previewPdfDte(prepared.invoice.company_id, prepared.body);
	}

	/**
	 * Escribe la emisión. Factura: Por Emitir → Emitida con el folio en `invoice_number`, fecha de emisión (hoy), vencimiento por condición
	 * de pago, líneas y encabezado en pesos iguales al DTE (y la tasa, si estaba en spot), montos en moneda del sistema y devengo. Nota: el
	 * folio y la fecha (como «Registrar folio»), sin cambiar su estado ni sus montos.
	 */
	private async applyIssued(
		runner: QueryRunner,
		prepared: DtePreparation,
		holdingId: string,
		created: { id: string; folio: number },
		trackId: string
	) {
		const { invoice, amounts } = prepared;
		const dteColumns = `dte_track_id = $3, dte_status = 'enviado', dte_status_detail = 'Enviado al SII', dte_status_at = now()`;

		if (prepared.note) {
			await runner.query(`UPDATE invoices SET invoice_number = $4, issue_date = $5::date, ${dteColumns} WHERE id = $1 AND holding_id = $2`, [
				invoice.id,
				holdingId,
				trackId,
				String(created.folio),
				prepared.issue_date,
			]);
			await runner.query(`UPDATE invoice_items SET issue_date = $3::date WHERE invoice_id = $1 AND holding_id = $2`, [
				invoice.id,
				holdingId,
				prepared.issue_date,
			]);

			return;
		}
		if (!amounts) return;
		const taxes = distributeTax(amounts);

		for (const [index, line] of amounts.lines.entries()) {
			const source = prepared.lines.find((row) => row.id === line.id)!;

			await runner.query(
				`UPDATE invoice_items SET unit_price_invoice_currency = $3, subtotal_invoice_currency = $4, tax_amount_invoice_currency = $5,
					total_invoice_currency = $6, fx_contract_to_invoice = COALESCE($7, fx_contract_to_invoice),
					fx_rate_source = CASE WHEN $7::numeric IS NULL THEN fx_rate_source ELSE COALESCE(fx_rate_source, 'official') END,
					fx_rate_date = CASE WHEN $7::numeric IS NULL THEN fx_rate_date ELSE $8::date END, issue_date = $8::date, updated_at = now()
				WHERE id = $1 AND holding_id = $2`,
				[
					line.id,
					holdingId,
					round6(line.monto / (Math.abs(source.quantity) || 1)),
					line.monto,
					taxes[index],
					line.monto + taxes[index],
					prepared.valuate ? prepared.fx : null,
					prepared.issue_date,
				]
			);
		}
		const dueDate = invoiceDueDate(prepared.issue_date, prepared.context);
		const [updated] = (await runner.query(
			`UPDATE invoices SET status = '${ISSUED_STATUS}', invoice_number = $4, issue_date = $5::date, due_date = $6::date,
				fx_contract_to_invoice = COALESCE($7, fx_contract_to_invoice), amount_invoice_currency = $8, vat = $9, total_invoice_currency = $10,
				${dteColumns}
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}' RETURNING id`,
			[
				invoice.id,
				holdingId,
				trackId,
				String(created.folio),
				prepared.issue_date,
				dueDate,
				prepared.valuate ? prepared.fx : null,
				amounts.neto + amounts.exento,
				amounts.iva,
				amounts.total,
			]
		)) as Row[];

		if (!updated) throw new ConflictException('La factura cambió de estado mientras se emitía: revisa su estado antes de volver a intentarlo');
		await refreshInvoiceSystemAmounts(runner, holdingId, [invoice.id]);
		const rsmFrom = [invoice.period_start, prepared.issue_date].filter((value): value is string => !!value).sort()[0];

		await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [prepared.context.contract_id, `${rsmFrom.slice(0, 7)}-01`]);
	}

	// ---------------------------------------------------------------- estado en el SII y entrega al receptor

	/** Consulta el estado del DTE en el SII y lo guarda; si queda válido (aceptado o con reparos), lo entrega al receptor. */
	async refreshDteStatus(idOrNumber: string, invoiceId: string, holdingId: string, authId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const row = await this.loadDteRow(this.dataSource, invoiceId, holdingId, contract.id);
		const result = await this.refreshRow(row, userId);

		return { ...result, invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId) };
	}

	/** Envía (o reenvía) el DTE al receptor: al correo indicado o al de intercambio de la razón social. */
	async sendDteToReceptor(idOrNumber: string, invoiceId: string, holdingId: string, authId: string, email?: string | null) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const row = await this.loadDteRow(this.dataSource, invoiceId, holdingId, contract.id);

		if (!DTE_VALID_STATUSES.includes(row.dte_status as DteStatus)) {
			throw new ConflictException({
				message: 'El SII todavía no acepta el documento: se envía al cliente cuando lo acepte',
				code: 'dte_not_accepted',
			});
		}
		const para = email?.trim() || row.receptor_email;

		if (!para) throw new ConflictException({ message: 'La razón social no tiene correo de intercambio', code: 'dte_receptor_without_email' });
		const delivery = await this.deliver(row, para, userId);

		if (delivery.error)
			throw new ConflictException({ message: `No se pudo enviar el documento al cliente: ${delivery.error}`, code: 'dte_receptor_failed' });

		return { ...delivery, invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId) };
	}

	/** PDF (tributario o cedible) o XML del DTE de la factura. */
	async dteDocument(
		idOrNumber: string,
		invoiceId: string,
		holdingId: string,
		formato: 'pdf' | 'xml',
		copia: 'tributaria' | 'cedible' = 'tributaria'
	) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const row = await this.loadDteRow(this.dataSource, invoiceId, holdingId, contract.id);

		return this.factura.documentoDte(row.company_id, row.dte_id, formato, copia);
	}

	/**
	 * Job horario: consulta en el SII los DTE enviados que aún no tienen resultado y entrega al receptor los válidos que no se le han enviado
	 * (sin error previo; un error se reintenta a mano con «Reenviar al cliente»). Sin usuario: no deja evento, solo el estado.
	 */
	async pollPendingDtes(limit = 100): Promise<{ consulted: number; delivered: number; failed: number }> {
		const rows = (await this.dataSource.query(
			`${DTE_ROW_SELECT}
			WHERE i.dte_id IS NOT NULL AND (i.dte_status = 'enviado'
				OR (i.dte_status IN ('aceptado', 'reparos') AND i.dte_receptor_sent_at IS NULL AND i.dte_receptor_error IS NULL
					AND NULLIF(trim(ce.email), '') IS NOT NULL))
			ORDER BY i.dte_status_at NULLS FIRST LIMIT $1`,
			[limit]
		)) as Row[];
		let consulted = 0;
		let delivered = 0;
		let failed = 0;

		for (const raw of rows) {
			const row = dteRowOf(raw);

			try {
				const result = await this.refreshRow(row, null);

				consulted += result.consulted ? 1 : 0;
				delivered += result.delivery && !result.delivery.error ? 1 : 0;
			} catch (error) {
				failed += 1;
				this.logger.warn(`Estado del DTE ${row.dte_id} (factura ${row.id}) no consultado: ${errorText(error)}`);
			}
		}

		return { consulted, delivered, failed };
	}

	private async refreshRow(row: DteRow, userId: string | null) {
		if (row.dte_status === 'creado') {
			throw new ConflictException({
				message: 'El documento tributario todavía no se envía al SII: usa «Emitir» para terminar',
				code: 'dte_not_sent',
			});
		}
		let status = row.dte_status as DteStatus;
		let consulted = false;

		if (status === 'enviado') {
			const estado = await this.factura.estadoDte(row.company_id, row.dte_id);

			consulted = true;
			status = dteStatusFromResultado(estado.resultado);
			await this.withWriter(async (runner) => {
				await runner.query(
					`UPDATE invoices SET dte_status = $3, dte_status_detail = $4, dte_status_at = now() WHERE id = $1 AND holding_id = $2`,
					[row.id, row.holding_id, status, `${estado.estado}: ${estado.glosaEstado}`.slice(0, 500)]
				);
				if (status !== row.dte_status && userId) {
					await this.insertEvent(runner, row.contract_id, row.holding_id, userId, {
						type: INVOICE_EVENT_TYPES.dte_status,
						title: `Documento tributario N° ${row.dte_folio ?? ''}: ${STATUS_LABELS[status]}`.trim(),
						description: `El SII respondió ${estado.estado} (${estado.glosaEstado})`,
						effective_date: isoDate(new Date()),
						invoice_id: row.id,
						metadata: { dte_id: row.dte_id, before: row.dte_status, after: status, estado: estado.estado, glosa: estado.glosaEstado },
					});
				}
			});
		}
		const valid = DTE_VALID_STATUSES.includes(status);
		const delivery =
			valid && !row.dte_receptor_sent_at && !row.dte_receptor_error && row.receptor_email
				? await this.deliver(row, row.receptor_email, userId)
				: null;

		return { dte_status: status, consulted, delivery };
	}

	private async deliver(row: DteRow, para: string, userId: string | null) {
		try {
			const sent = await this.factura.enviarReceptor(row.company_id, row.dte_id, para);

			await this.withWriter(async (runner) => {
				await runner.query(
					`UPDATE invoices SET dte_receptor_email = $3, dte_receptor_sent_at = now(), dte_receptor_error = NULL WHERE id = $1 AND holding_id = $2`,
					[row.id, row.holding_id, para]
				);
				if (userId) {
					await this.insertEvent(runner, row.contract_id, row.holding_id, userId, {
						type: INVOICE_EVENT_TYPES.dte_receptor,
						title: `Documento tributario N° ${row.dte_folio ?? ''} enviado al cliente`.trim(),
						description: `Enviado a ${para}`,
						effective_date: isoDate(new Date()),
						invoice_id: row.id,
						metadata: { dte_id: row.dte_id, para, message_id: sent.messageId ?? null },
					});
				}
			});

			return { para, sent: true, error: null as string | null };
		} catch (error) {
			const message = errorText(error).slice(0, 500);

			await this.withWriter((runner) =>
				runner.query(`UPDATE invoices SET dte_receptor_email = $3, dte_receptor_error = $4 WHERE id = $1 AND holding_id = $2`, [
					row.id,
					row.holding_id,
					para,
					message,
				])
			);

			return { para, sent: false, error: message };
		}
	}

	// ---------------------------------------------------------------- nota de débito (56)

	async previewDebitNote(idOrNumber: string, invoiceId: string, dto: CreateDebitNoteDto, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const original = await this.loadDebitNoteOriginal(this.dataSource, contract.id, invoiceId, holdingId);

		return this.debitNotePreview(original, planDebitNote(original, dto));
	}

	/**
	 * Crea la nota de débito sobre una factura emitida: una línea con el neto y el motivo, el IVA de la factura, la referencia a la factura
	 * (`CodRef` 3) y el evento `INVOICE_DEBIT_NOTE_CREATED`. Nace Emitida y pendiente de emisión: se emite como DTE 56 con «Emitir». No
	 * cambia la factura original ni el devengo del contrato (un recargo o interés no es ingreso del servicio).
	 */
	async createDebitNote(idOrNumber: string, invoiceId: string, dto: CreateDebitNoteDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const day = isoDate(today);

		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const original = await this.loadDebitNoteOriginal(runner, contract.id, invoiceId, holdingId, true);
			const plan = planDebitNote(original, dto);

			if (!plan.can_apply) throw this.blocked(plan.blockers, this.debitNotePreview(original, plan));
			const [source] = (await runner.query(
				`SELECT company_id, client_id, client_entity_id, contract_id, contract_currency, invoice_currency, system_currency, fx_contract_to_invoice,
					fx_contract_to_system, issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id, payment_method, fiscal_regime, export_type,
					tax_rate, invoice_series
				FROM invoices WHERE id = $1 AND holding_id = $2`,
				[original.id, holdingId]
			)) as Row[];
			const fx = toNullableNumber(source.fx_contract_to_invoice);
			const sameCurrency = String(source.contract_currency ?? '').toUpperCase() === String(source.invoice_currency ?? '').toUpperCase();
			const toContract = (value: number) => (sameCurrency ? value : fx ? round2(value / fx) : value);
			const [header] = (await runner.query(
				`INSERT INTO invoices (
					invoice_group_id, invoice_terms_and_conditions,
					holding_id, contract_id, company_id, client_id, client_entity_id,
					scheduled_at, original_issue_date, issue_date, due_date, status,
					contract_currency, invoice_currency, system_currency,
					amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency,
					fx_contract_to_invoice, fx_contract_to_system,
					invoice_type, document_type, related_invoice_id,
					issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id, payment_method, fiscal_regime, export_type, tax_rate, invoice_series, notes, is_active
				) VALUES (
					(SELECT COALESCE(r.invoice_group_id, r.id) FROM invoices r WHERE r.id = $17::uuid), ${invoiceTermsSql(2)},
					$1, $2, $3, $4, $5,
					$6, $6, $6, NULL, '${ISSUED_STATUS}',
					$7, $8, $9,
					$10, $11, $12, $13,
					$14, $15,
					'Manual', 'ND', $17,
					$18, $19, $20, $21, $22, $23, $24, $16, $25, $26, true
				) RETURNING id`,
				[
					holdingId,
					source.contract_id,
					source.company_id,
					source.client_id,
					source.client_entity_id,
					day,
					source.contract_currency,
					source.invoice_currency,
					source.system_currency,
					toContract(plan.amount),
					plan.amount,
					plan.vat,
					plan.total,
					source.fx_contract_to_invoice,
					source.fx_contract_to_system,
					source.tax_rate,
					original.id,
					source.issuer_tax_id,
					source.issuer_legal_name,
					source.issuer_address,
					source.client_tax_id,
					source.payment_method,
					source.fiscal_regime,
					source.export_type,
					source.invoice_series,
					`Nota de débito de la factura ${original.invoice_number}: ${plan.reason}`,
				]
			)) as Row[];
			const debitNoteId = String(header.id);

			await runner.query(
				`INSERT INTO invoice_items (
					holding_id, invoice_id, contract_id, description, quantity, unit_of_measure,
					unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
					subtotal_contract_currency, subtotal_invoice_currency, tax_amount_contract_currency, tax_amount_invoice_currency,
					total_contract_currency, total_invoice_currency, contract_currency, invoice_currency, fx_contract_to_invoice,
					status, issue_date, billing_period_start, billing_period_end
				) VALUES ($1, $2, $3, $4, 1, 'UND', $5, $6, 0, $5, $6, $7, $8, $9, $10, $11, $12, $13, '${ISSUED_STATUS}', $14::date, $14::date, $14::date)`,
				[
					holdingId,
					debitNoteId,
					source.contract_id,
					`Nota de débito: ${plan.reason}`.slice(0, 1000),
					toContract(plan.amount),
					plan.amount,
					toContract(plan.vat),
					plan.vat,
					toContract(plan.total),
					plan.total,
					source.contract_currency,
					source.invoice_currency,
					source.fx_contract_to_invoice,
					day,
				]
			);
			await mirrorInvoiceSystemAmounts(runner, holdingId, debitNoteId, original.id);
			await insertCreditNoteReference(
				runner,
				debitNoteId,
				{ id: original.id, invoice_number: original.invoice_number, issue_date: original.issue_date },
				holdingId,
				'discount',
				`Nota de débito sobre ${original.invoice_number}: ${plan.reason}`.slice(0, 90),
				userId
			);
			const eventId = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.debit_note,
				title: `Nota de débito sobre la factura ${original.invoice_number}`,
				description: `Nota de débito por ${plan.total} ${source.invoice_currency ?? ''} (${plan.reason}); pendiente de emisión`.replace(
					/\s+/g,
					' '
				),
				effective_date: day,
				invoice_id: original.id,
				metadata: { debit_note_id: debitNoteId, amount: plan.amount, vat: plan.vat, total: plan.total, reason: plan.reason },
			});

			return { preview: this.debitNotePreview(original, plan), debitNoteId, eventId };
		});

		return {
			...result.preview,
			applied: true,
			debit_note_id: result.debitNoteId,
			event_id: result.eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, result.debitNoteId, holdingId),
		};
	}

	private debitNotePreview(original: DebitNoteOriginal, plan: DebitNotePlan) {
		return {
			invoice: { id: original.id, invoice_number: original.invoice_number, status: original.status, issue_date: original.issue_date },
			debit_note: { amount: plan.amount, vat: plan.vat, total: plan.total, currency: original.invoice_currency, reason: plan.reason },
			blockers: plan.blockers,
			warnings: plan.warnings,
			can_apply: plan.can_apply,
		};
	}

	private async loadDebitNoteOriginal(
		db: Queryable,
		contractId: string,
		invoiceId: string,
		holdingId: string,
		lock = false
	): Promise<DebitNoteOriginal> {
		const [row] = (await db.query(
			`SELECT id, status, document_type, is_active, invoice_number, issue_date::text AS issue_date, invoice_currency, tax_rate, dte_status
			FROM invoices WHERE id = $1::uuid AND contract_id = $2 AND holding_id = $3${lock ? ' FOR UPDATE' : ''}`,
			[invoiceId, contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Factura no encontrada');

		return {
			id: String(row.id),
			status: toText(row.status),
			document_type: toText(row.document_type),
			is_active: row.is_active !== false,
			invoice_number: toText(row.invoice_number)?.trim() || null,
			issue_date: toText(row.issue_date),
			invoice_currency: toText(row.invoice_currency),
			tax_rate: toNullableNumber(row.tax_rate),
			dte_status: toText(row.dte_status),
		};
	}

	// ---------------------------------------------------------------- datos de exportación

	/** Guarda los datos de exportación del contrato (`contracts.export_details`). Sin campos con valor, queda NULL. */
	async updateContractExportDetails(idOrNumber: string, holdingId: string, dto: ContractExportDetailsDto) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const details = cleanExportDetails(dto as Record<string, unknown>);

		await this.transaction(contract.id, holdingId, async (runner) => {
			await runner.query(`UPDATE contracts SET export_details = $3::jsonb WHERE id = $1 AND holding_id = $2`, [
				contract.id,
				holdingId,
				details ? JSON.stringify(details) : null,
			]);
		});

		return { contract_id: contract.id, export_details: details };
	}

	/**
	 * Guarda los datos del embarque de una factura de exportación (`invoices.export_details`) antes de emitirla: solo una Por Emitir que
	 * todavía no tiene DTE (después, el documento ya los lleva).
	 */
	async updateInvoiceExportDetails(idOrNumber: string, invoiceId: string, holdingId: string, dto: InvoiceExportDetailsDto) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const details = cleanExportDetails(dto as Record<string, unknown>);

		const updated = await this.transaction(contract.id, holdingId, async (runner) => {
			const [row] = (await runner.query(
				`SELECT status, dte_id, dte_status FROM invoices WHERE id = $1 AND holding_id = $2 AND contract_id = $3`,
				[invoiceId, holdingId, contract.id]
			)) as Row[];

			if (!row) throw new NotFoundException('Factura no encontrada');
			if (row.status !== PENDING_STATUS || (row.dte_id && row.dte_status !== 'rechazado')) {
				throw new ConflictException({
					message: 'Los datos del embarque se editan antes de emitir la factura',
					code: 'invoice_not_pending',
				});
			}
			await runner.query(`UPDATE invoices SET export_details = $3::jsonb WHERE id = $1 AND holding_id = $2`, [
				invoiceId,
				holdingId,
				details ? JSON.stringify(details) : null,
			]);

			return details;
		});

		return { invoice_id: invoiceId, export_details: updated };
	}

	// ---------------------------------------------------------------- preparar

	private async prepare(db: Queryable, contractId: string, invoiceId: string, holdingId: string, today: string): Promise<DtePreparation> {
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const invoice = await this.invoices.loadInvoice(db, contractId, invoiceId, holdingId);
		const [extra] = (await db.query(
			`SELECT i.related_invoice_id, i.credit_type, i.due_date::text AS due_date, t.code AS contract_document_code,
				EXISTS (SELECT 1 FROM sii_configurations s WHERE s.company_id = i.company_id AND s.holding_id = i.holding_id AND s.is_enabled = true) AS has_electronic_invoicing,
				ce.tax_id, ce.legal_name AS receptor_legal_name, ce.economic_activity, ce.legal_address, ce.commune, ce.email,
				ce.country_code, ce.city, i.client_entity_id, i.export_type, c.export_details AS contract_export_details,
				i.export_details AS invoice_export_details
			FROM invoices i
			LEFT JOIN contracts c ON c.id = i.contract_id
			LEFT JOIN tax_document_types t ON t.id = c.tax_document_type_id
			LEFT JOIN client_entities ce ON ce.id = i.client_entity_id AND ce.holding_id = i.holding_id
			WHERE i.id = $1 AND i.holding_id = $2`,
			[invoice.id, holdingId]
		)) as Row[];
		const receptor: DteReceptor | null = extra?.client_entity_id
			? {
					tax_id: toText(extra.tax_id),
					legal_name: toText(extra.receptor_legal_name),
					economic_activity: toText(extra.economic_activity),
					legal_address: toText(extra.legal_address),
					commune: toText(extra.commune),
					email: toText(extra.email),
					country_code: toText(extra.country_code),
					city: toText(extra.city),
				}
			: null;
		const tipoContext = {
			has_electronic_invoicing: extra?.has_electronic_invoicing === true,
			has_erp_integration: context.has_erp_integration,
			contract_document_code: toText(extra?.contract_document_code),
			today,
		};
		const note = invoice.document_type === 'ND' || /^NC/i.test(invoice.document_type ?? '');
		// Reemisión de un DTE rechazado: se planea como si la factura volviera a estar Por Emitir y sin folio (el rechazado no vale).
		const planned = isDteRejected(invoice) ? asReissued(invoice, note) : invoice;
		const original = note && extra?.related_invoice_id ? await this.loadOriginal(db, String(extra.related_invoice_id), holdingId) : null;
		// Exportación: la factura lo es (`export_type = 1`, que copian sus NC y ND) o la nota corrige un documento de exportación.
		const exportDocument = Number(extra?.export_type) === 1 || isExportDte(original?.dte_tipo);
		const pendingNote =
			note &&
			creditNotePendingEmission({
				document_type: invoice.document_type,
				status: planned.status,
				credit_type: toText(extra?.credit_type),
				due_date: toText(extra?.due_date),
				odoo_invoice_id: invoice.odoo_invoice_id,
				sent_to_odoo_at: invoice.sent_to_odoo_at,
				invoice_number: planned.invoice_number,
			});
		// Base: las de toda operación sobre una Por Emitir (sin el DTE a medio emitir, que «Emitir» termina). Las notas tienen sus propias.
		const base: InvoiceBlocker[] = note
			? []
			: [...commonBlockers(planned), erpDraftBlocker(invoice), partialBillingBlocker(invoice)]
					.filter((blocker): blocker is InvoiceBlocker => !!blocker)
					.filter((blocker) => blocker.code !== DTE_IN_PROGRESS_CODE)
					.map((blocker) =>
						blocker.code === 'partial_billing_invoice'
							? {
									...blocker,
									code: 'dte_partial_billing',
									message: 'Las facturas por OC todavía no se emiten como documento tributario',
									next_step: null,
								}
							: blocker
					);
		const lines = await this.loadDteLines(db, invoice.id, holdingId);
		// Una nota copia los montos (y la tasa) de su factura original: no se revaloriza.
		const valuation = note ? { fx: invoice.fx_contract_to_invoice, valuate: false, blocker: null } : await this.valuation(invoice, lines, today);

		if (valuation.blocker) base.push(valuation.blocker);
		if (invoice.tax_rate === null && !note && !exportDocument) {
			base.push({
				code: 'tax_rate_missing',
				message: 'La factura no tiene tasa de IVA',
				next_step: 'Completa la tasa de impuesto de la compañía',
			});
		}
		const plan = planEmitDte(invoice, tipoContext, {
			receptor,
			base_blockers: base,
			original,
			pending_note: pendingNote,
			export_document: exportDocument,
		});
		const issueDate = today;
		const exportacion = isExportDte(plan.tipo) ? await this.exportInput(invoice, extra, today, plan) : null;
		let amounts: DteAmounts | null = null;
		let body: Record<string, unknown> | null = null;

		if (plan.tipo && (valuation.fx !== null || !isMultiCurrency(invoice) || note || !valuation.valuate)) {
			const source = this.sourceLines(invoice, lines, valuation.fx, valuation.valuate);

			amounts = exportacion
				? dteExportAmounts(source, invoice.invoice_currency)
				: dteAmounts(source, invoice.tax_rate ?? 19, plan.tipo === DTE_TYPES.exempt_invoice);
			body = mapInvoiceToDteBody({
				tipo: plan.tipo as DteTipo,
				issue_date: issueDate,
				due_date: note ? null : invoiceDueDate(issueDate, context),
				receptor: receptor ?? {
					tax_id: null,
					legal_name: null,
					economic_activity: null,
					legal_address: null,
					commune: null,
					email: null,
				},
				amounts,
				references: [
					...(await this.loadReferences(db, invoice.id, holdingId, original, note)),
					...(exportacion && !note ? dusReference(exportacion, issueDate) : []),
				],
				// Nota del tipo de cambio en cada línea (contrato en UF u otra moneda); las notas de crédito y débito no la llevan.
				fx:
					!note && isMultiCurrency(invoice) && valuation.fx
						? { rate: valuation.fx, currency: invoice.contract_currency!, date: valuation.fxDate ?? null }
						: null,
				exportacion,
			});
			if (amounts.total <= 0) plan.blockers.push({ code: 'dte_zero_total', message: 'El documento tiene total 0', next_step: null });
			plan.can_apply = plan.blockers.length === 0;
		}

		return {
			invoice,
			context,
			plan,
			receptor,
			original,
			lines,
			fx: valuation.fx,
			valuate: valuation.valuate,
			fxDate: valuation.fxDate ?? null,
			amounts,
			body,
			issue_date: issueDate,
			note,
			exportacion,
		};
	}

	/**
	 * Lo que agrega un documento de exportación: la moneda, los datos de exportación del contrato y del embarque, y el tipo de cambio a
	 * pesos de `OtraMoneda` (obligatorio en moneda extranjera): el dólar observado del día de emisión (o el último anterior) y, para el euro,
	 * EUR → USD × dólar observado. Sin tasa, bloquea la emisión.
	 */
	private async exportInput(invoice: ContractInvoiceRow, extra: Row | undefined, today: string, plan: EmitDtePlan): Promise<DteExportInput> {
		const currency = (invoice.invoice_currency ?? '').toUpperCase();
		const input: DteExportInput = {
			currency,
			clp_rate: null,
			contract: (extra?.contract_export_details as DteExportInput['contract']) ?? null,
			invoice: (extra?.invoice_export_details as DteExportInput['invoice']) ?? null,
		};

		if (currency === 'CLP' || !EXPORT_CURRENCIES[currency]) return input;
		try {
			const usdClp = (await this.exchangeRates.getExchangeRateWithFallback('USD', 'CLP', today))?.rate;
			const crossUsd = currency === 'USD' ? 1 : (await this.exchangeRates.getExchangeRateWithFallback(currency, 'USD', today))?.rate;

			if (usdClp > 0 && crossUsd > 0) return { ...input, clp_rate: roundTo(usdClp * crossUsd, 4) };
		} catch (error) {
			this.logger.warn(`Sin tipo de cambio ${currency} → CLP al ${today} para la factura de exportación ${invoice.id}: ${errorText(error)}`);
		}
		plan.blockers.push({
			code: 'dte_export_fx_missing',
			message: `No hay dólar observado${currency === 'USD' ? '' : ` ni tasa ${currency} → USD`} para la fecha de emisión: el documento de exportación lleva su equivalente en pesos`,
			next_step: 'Revisa la carga de tipos de cambio del Banco Central',
		});
		plan.can_apply = false;

		return input;
	}

	/**
	 * Tasa para pasar las líneas a pesos. Misma moneda: ninguna. Ya valorizada (tasa fija o neto exacto): sus montos tal cual. Spot: la
	 * tasa oficial del día de emisión (la que usaría el envío al ERP), o la última anterior si ese día no hay.
	 */
	private async valuation(
		invoice: ContractInvoiceRow,
		lines: DteLineRow[],
		today: string
	): Promise<{ fx: number | null; valuate: boolean; blocker: InvoiceBlocker | null; fxDate?: string | null }> {
		if (!isMultiCurrency(invoice)) return { fx: null, valuate: false, blocker: null };
		const valued = invoice.amount_invoice_currency !== null && lines.every((line) => line.subtotal_invoice_currency !== null);

		if (valued) return { fx: invoice.fx_contract_to_invoice, valuate: false, blocker: null };
		if (invoice.fx_contract_to_invoice !== null) return { fx: invoice.fx_contract_to_invoice, valuate: true, blocker: null };
		try {
			const rate = await this.exchangeRates.getExchangeRateWithFallback(invoice.contract_currency!, invoice.invoice_currency!, today);
			// Día de la tasa usada (si no había del día de emisión, la última anterior): va en la nota de cada línea.
			const rateDate =
				rate?.rate_date instanceof Date ? isoDate(rate.rate_date) : rate?.rate_date ? String(rate.rate_date).slice(0, 10) : today;

			if (rate?.rate > 0) return { fx: round6(rate.rate), valuate: true, blocker: null, fxDate: rateDate };
		} catch (error) {
			this.logger.warn(`Sin tasa ${invoice.contract_currency}→${invoice.invoice_currency} al ${today}: ${errorText(error)}`);
		}

		return {
			fx: null,
			valuate: true,
			blocker: {
				code: 'fx_rate_missing',
				message: `No hay tipo de cambio ${invoice.contract_currency} → ${invoice.invoice_currency} para la fecha de emisión`,
				next_step: 'Confirma la tasa desde Tipo de cambio de la factura',
			},
		};
	}

	/** Líneas en moneda de factura (CLP) para el DTE: valorizadas con la tasa si estaban en spot; las ya valorizadas, tal cual. */
	private sourceLines(invoice: ContractInvoiceRow, lines: DteLineRow[], fx: number | null, valuate: boolean): DteSourceLine[] {
		const valued = valuate && fx !== null ? fixedFxLines(lines, fx) : null;

		return lines.map((line, index) => ({
			id: line.id,
			description: line.description,
			quantity: line.quantity,
			unit_of_measure: line.unit_of_measure,
			contract_amount: isMultiCurrency(invoice) ? line.subtotal_contract_currency : null,
			subtotal_invoice_currency: valued
				? (valued[index].after.subtotal_invoice_currency ?? 0)
				: (line.subtotal_invoice_currency ??
					(isMultiCurrency(invoice) ? round2(line.subtotal_contract_currency * (fx ?? 0)) : line.subtotal_contract_currency)),
		}));
	}

	private async loadDteLines(db: Queryable, invoiceId: string, holdingId: string): Promise<DteLineRow[]> {
		const rows = (await db.query(
			`SELECT ii.id, ii.description, ii.quantity, ii.unit_of_measure, ii.unit_price_contract_currency, ii.subtotal_contract_currency,
				ii.tax_amount_contract_currency, ii.total_contract_currency, ii.unit_price_invoice_currency, ii.subtotal_invoice_currency,
				ii.tax_amount_invoice_currency, ii.total_invoice_currency, ii.created_at, ii.visible_line_id
			FROM invoice_items ii WHERE ii.invoice_id = $1 AND ii.holding_id = $2
			ORDER BY ii.created_at, ii.id`,
			[invoiceId, holdingId]
		)) as Row[];
		// Las mismas que viajan al ERP: visibles (sin `visible_line_id`) y con cantidad.
		const sent = InvoiceSchedulerService.itemsSentToErp({ items: rows });

		return sent.map((row) => ({
			id: String(row.id),
			description: toText(row.description),
			quantity: toNumber(row.quantity),
			unit_of_measure: toText(row.unit_of_measure),
			unit_price_contract_currency: toNumber(row.unit_price_contract_currency),
			subtotal_contract_currency: toNumber(row.subtotal_contract_currency),
			tax_amount_contract_currency: toNumber(row.tax_amount_contract_currency),
			total_contract_currency: toNumber(row.total_contract_currency),
			unit_price_invoice_currency: toNullableNumber(row.unit_price_invoice_currency),
			subtotal_invoice_currency: toNullableNumber(row.subtotal_invoice_currency),
			tax_amount_invoice_currency: toNullableNumber(row.tax_amount_invoice_currency),
			total_invoice_currency: toNullableNumber(row.total_invoice_currency),
			created_at: toText(row.created_at),
		}));
	}

	private async loadOriginal(db: Queryable, originalId: string, holdingId: string): Promise<DteOriginal | null> {
		const [row] = (await db.query(
			`SELECT id, invoice_number, issue_date::text AS issue_date, dte_tipo, dte_status FROM invoices WHERE id = $1 AND holding_id = $2`,
			[originalId, holdingId]
		)) as Row[];

		return row
			? {
					id: String(row.id),
					invoice_number: toText(row.invoice_number)?.trim() || null,
					issue_date: toText(row.issue_date),
					dte_tipo: toNullableNumber(row.dte_tipo),
					dte_status: toText(row.dte_status),
				}
			: null;
	}

	/**
	 * Referencias del DTE. Factura: las suyas y las OC/HES vinculadas. Nota: la de su factura original (la escribe Anular o la NC), con el
	 * folio que tiene hoy la original (puede haberse emitido después de crear la nota) y su tipo SII si se emitió como DTE.
	 */
	private async loadReferences(db: Queryable, invoiceId: string, holdingId: string, original: DteOriginal | null, note: boolean) {
		const own = (await db.query(
			`SELECT document_type_code, document_number, reference_date::text AS reference_date, reference_code, reason
			FROM invoice_references WHERE invoice_id = $1 AND holding_id = $2 ORDER BY created_at`,
			[invoiceId, holdingId]
		)) as Row[];
		const linked = note
			? []
			: ((await db.query(
					`SELECT br.reference_type::text AS reference_type, br.reference_code, br.issue_date::text AS issue_date
					FROM invoice_reference_links rl JOIN billing_references br ON br.id = rl.reference_id
					WHERE rl.invoice_id = $1`,
					[invoiceId]
				)) as Row[]);
		const references = dteReferencesOf(
			own.map((row) => ({
				document_type_code: toText(row.document_type_code),
				document_number: toText(row.document_number),
				reference_date: toText(row.reference_date),
				reference_code: toText(row.reference_code),
				reason: toText(row.reason),
			})),
			linked.map((row) => ({
				reference_type: toText(row.reference_type),
				reference_code: toText(row.reference_code),
				issue_date: toText(row.issue_date),
			}))
		);

		if (!note || !original?.invoice_number) return references;
		const toOriginal = references.find((reference) => ['33', '34', '56', '61', '110', '111', '112'].includes(reference.document_type_code));

		if (toOriginal) {
			toOriginal.document_number = original.invoice_number;
			toOriginal.document_type_code = String(original.dte_tipo ?? toOriginal.document_type_code);
			toOriginal.reference_date = original.issue_date ?? toOriginal.reference_date;

			return references;
		}

		return [
			{
				document_type_code: String(original.dte_tipo ?? DTE_TYPES.invoice),
				document_number: original.invoice_number,
				reference_date: original.issue_date,
				reference_code: 3,
				reason: 'Corrige montos',
			},
			...references,
		];
	}

	private async loadDteRow(db: Queryable, invoiceId: string, holdingId: string, contractId: string): Promise<DteRow> {
		const [raw] = (await db.query(`${DTE_ROW_SELECT} WHERE i.id = $1::uuid AND i.holding_id = $2 AND i.contract_id = $3`, [
			invoiceId,
			holdingId,
			contractId,
		])) as Row[];

		if (!raw) throw new NotFoundException('Factura no encontrada');
		const row = dteRowOf(raw);

		if (!row.dte_id) throw new ConflictException({ message: 'La factura no se emitió como documento tributario', code: 'no_dte' });

		return row;
	}

	private preview(prepared: DtePreparation) {
		const { invoice, plan, amounts } = prepared;

		return {
			invoice: { id: invoice.id, invoice_number: invoice.invoice_number, status: invoice.status, issue_date: invoice.issue_date },
			document: plan.tipo
				? {
						tipo: plan.tipo,
						label: DTE_TYPE_LABELS[plan.tipo],
						issue_date: prepared.issue_date,
						due_date: prepared.note ? null : invoiceDueDate(prepared.issue_date, prepared.context),
						receptor: prepared.receptor
							? {
									tax_id: prepared.receptor.tax_id,
									legal_name: prepared.receptor.legal_name,
									giro: prepared.receptor.economic_activity,
									address: prepared.receptor.legal_address,
									commune: prepared.receptor.commune,
									city: prepared.receptor.city ?? null,
									country_code: prepared.receptor.country_code ?? null,
									email: receptorEmailOf(prepared.receptor),
								}
							: null,
						// Moneda del documento (en exportación, la de la factura) y, en moneda extranjera, el equivalente en pesos (OtraMoneda).
						currency: prepared.exportacion?.currency ?? 'CLP',
						export: prepared.exportacion
							? {
									services: prepared.exportacion.contract?.kind !== 'bienes',
									clp_rate: prepared.exportacion.clp_rate,
									total_clp:
										prepared.exportacion.clp_rate && amounts ? Math.round(amounts.total * prepared.exportacion.clp_rate) : null,
									aduana:
										((prepared.body?.Encabezado as Record<string, any> | undefined)?.Transporte?.Aduana as Record<
											string,
											unknown
										>) ?? null,
								}
							: null,
						lines: amounts?.lines.map((line) => ({ description: line.description, quantity: line.quantity, amount: line.monto })) ?? [],
						neto: amounts?.neto ?? null,
						exento: amounts?.exento ?? null,
						iva: amounts?.iva ?? null,
						total: amounts?.total ?? null,
						fx: prepared.fx,
						fx_currency: isMultiCurrency(invoice) ? invoice.contract_currency : null,
						references: ((prepared.body?.Referencia as Array<Record<string, unknown>> | undefined) ?? []).map((reference) => ({
							type: reference.TpoDocRef,
							folio: reference.FolioRef,
							date: reference.FchRef,
							code: reference.CodRef ?? null,
						})),
						retry: plan.retry,
					}
				: null,
			blockers: plan.blockers,
			warnings: plan.warnings,
			can_apply: plan.can_apply,
		};
	}

	// ---------------------------------------------------------------- infraestructura

	private async transaction<T>(contractId: string, holdingId: string, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		return this.withWriter(async (runner) => {
			await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
				contractId,
				holdingId,
			]);

			return work(runner);
		});
	}

	/** Transacción corta con la costura `sapira.writer = 'api'`. */
	private async withWriter<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();
		let active = false;

		await runner.connect();
		await runner.startTransaction();
		active = true;
		try {
			await setApiWriter(runner);
			const result = await work(runner);

			await runner.commitTransaction();
			active = false;

			return result;
		} catch (error) {
			if (active) await runner.rollbackTransaction();
			if (!(error instanceof HttpException)) this.logger.warn(`Escritura del documento tributario no aplicada: ${errorText(error)}`);
			throw error;
		} finally {
			await runner.release();
		}
	}

	private blocked(blockers: InvoiceBlocker[], preview: unknown): ConflictException {
		return new ConflictException({
			message: `No se puede emitir: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			preview,
		});
	}

	private async insertEvent(
		runner: Queryable,
		contractId: string,
		holdingId: string,
		userId: string,
		event: {
			type: string;
			title: string;
			description: string;
			effective_date: string | null;
			invoice_id: string;
			metadata: Record<string, unknown>;
		}
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb) RETURNING id`,
			[
				contractId,
				holdingId,
				event.type,
				event.title,
				event.description,
				userId,
				event.effective_date,
				JSON.stringify({ source: 'contract_360', invoice_id: event.invoice_id, ...event.metadata }),
			]
		)) as Row[];

		return String(row.id);
	}
}

const STATUS_LABELS: Record<DteStatus, string> = {
	creado: 'creado sin enviar',
	enviado: 'enviado al SII',
	aceptado: 'aceptado por el SII',
	reparos: 'aceptado con reparos',
	rechazado: 'rechazado por el SII',
};

/** Factura con su DTE y el correo del receptor, para consultar estado y entregarlo. */
const DTE_ROW_SELECT = `SELECT i.id, i.holding_id, i.contract_id, i.company_id, i.dte_id, i.dte_folio, i.dte_status,
		i.dte_receptor_sent_at, i.dte_receptor_error, NULLIF(trim(ce.email), '') AS receptor_email
	FROM invoices i LEFT JOIN client_entities ce ON ce.id = i.client_entity_id AND ce.holding_id = i.holding_id`;

interface DteRow {
	id: string;
	holding_id: string;
	contract_id: string;
	company_id: string;
	dte_id: string;
	dte_folio: number | null;
	dte_status: string | null;
	dte_receptor_sent_at: string | null;
	dte_receptor_error: string | null;
	receptor_email: string | null;
}

function dteRowOf(row: Row): DteRow {
	return {
		id: String(row.id),
		holding_id: String(row.holding_id),
		contract_id: String(row.contract_id),
		company_id: String(row.company_id),
		dte_id: toText(row.dte_id) ?? '',
		dte_folio: toNullableNumber(row.dte_folio),
		dte_status: toText(row.dte_status),
		dte_receptor_sent_at: toText(row.dte_receptor_sent_at),
		dte_receptor_error: toText(row.dte_receptor_error),
		receptor_email: toText(row.receptor_email),
	};
}

/** Referencia al DUS (documento único de salida, código 807) de una factura de exportación, si el embarque lo trae. */
function dusReference(exportacion: DteExportInput, issueDate: string) {
	const number = exportacion.invoice?.dus_number?.trim();

	return number
		? [
				{
					document_type_code: '807',
					document_number: number,
					reference_date: exportacion.invoice?.dus_date ?? issueDate,
					reference_code: null,
					reason: 'DUS',
				},
			]
		: [];
}

/** Datos de exportación sin los campos vacíos; null si no queda ninguno. */
export function cleanExportDetails(details: Record<string, unknown>): Record<string, unknown> | null {
	const clean = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== ''));

	return Object.keys(clean).length ? clean : null;
}

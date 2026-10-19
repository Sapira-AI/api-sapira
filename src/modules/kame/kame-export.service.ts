import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { FacturaClientService } from '@/modules/factura/factura-client.service';
import type { RevenueJournalDto } from '@/modules/metrics/dtos/query-metrics.dto';
import { RevenueMetricsService } from '@/modules/metrics/revenue-metrics.service';
import { INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE, NotificationsService } from '@/modules/notifications/notifications.service';

import { KameApiError, KameClientService } from './kame-client.service';
import { type KameConnectionRow, KameConnectionsService, type KameSettingsRow } from './kame-connections.service';
import { documentRequest, journalBody, type JournalMonthInput, KameMappingError, parseIssuedDte } from './kame-mapper';
import { isKameRutAllowed, KAME_DOCUMENT_NAMES, KAME_ENVIRONMENT_LABELS, type KameEnvironment, nextRetryDelay } from './kame.types';

/** Fila de la cola (`erp_exports`) con lo que hace falta para enviarla. */
interface ExportRow {
	id: string;
	holding_id: string;
	company_id: string;
	environment: KameEnvironment;
	object: 'invoice' | 'journal';
	invoice_id: string | null;
	period: string | null;
	status: string;
	attempts: number;
}

interface Prepared {
	endpoint: string;
	body: unknown;
	/** Para la verificación previa al reintento (`getVenta`): solo documentos que Kame deja consultar. */
	lookup: { documento: string; folio: number } | null;
	label: string;
}

export interface ProcessOptions {
	holdingId?: string;
	companyId?: string;
	ids?: string[];
	/** Usuario que lo pidió (null = job). */
	requestedBy?: string | null;
	limit?: number;
}

export interface ProcessResult {
	processed: number;
	sent: number;
	simulated: number;
	errors: number;
	skipped: number;
}

const PERIOD = /^\d{4}-\d{2}$/;
/** Una fila `sending` más vieja que esto quedó trabada (la API se reinició a mitad del envío). */
export const STUCK_SENDING_MINUTES = 30;
const journalComment = (period: string) => `Devengo de ingresos ${period.slice(0, 7)} · Sapira`;

/**
 * Cola de envíos a Kame (`erp_exports`): encola lo que corresponde y lo envía, con idempotencia por ambiente y reintentos con espera.
 *
 * - **Encolar** (`enqueue`): facturas emitidas en Sapira como DTE y válidas ante el SII (`aceptado`/`reparos`) desde `invoices_from`, y
 *   meses de asientos de devengo cerrados desde `journal_from`, de las compañías con conexión activa e interruptor prendido. Barre la base
 *   en vez de engancharse a la emisión: nada se pierde si un proceso se cae, y lo que se emitió con el job apagado igual queda en cola.
 * - **Enviar** (`process`): toma lo vencido con `FOR UPDATE SKIP LOCKED`; en simulación guarda el cuerpo como `simulated` sin llamar a
 *   Kame; en un reintento de una venta consulta antes `getVenta` y, si ya existe, la da por enviada sin crearla de nuevo. Los errores
 *   esperan 1 h, 4 h, 24 h…; al agotar los intentos la factura avisa a los responsables (el mismo aviso de «factura al ERP»).
 */
@Injectable()
export class KameExportService {
	private readonly logger = new Logger(KameExportService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly connections: KameConnectionsService,
		private readonly client: KameClientService,
		private readonly factura: FacturaClientService,
		private readonly revenue: RevenueMetricsService,
		private readonly notifications: NotificationsService
	) {}

	// ── Encolar ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** Encola facturas y meses pendientes (de un holding o de todos). Devuelve cuántas filas nuevas quedaron en cola. */
	async enqueue(holdingId?: string, companyId?: string): Promise<{ invoices: number; journal: number }> {
		const params: unknown[] = [];
		const scope = [holdingId ? `s.holding_id = $${params.push(holdingId)}` : null, companyId ? `s.company_id = $${params.push(companyId)}` : null]
			.filter(Boolean)
			.map((condition) => ` AND ${condition}`)
			.join('');
		const invoices = await this.dataSource.query(
			`INSERT INTO erp_exports (holding_id, company_id, system, environment, object, invoice_id)
			SELECT i.holding_id, i.company_id, 'kame', s.active_environment, 'invoice', i.id
			FROM kame_company_settings s
			JOIN kame_connections k ON k.company_id = s.company_id AND k.environment = s.active_environment
			JOIN companies co ON co.id = s.company_id AND co.odoo_integration_id IS NULL
			JOIN invoices i ON i.company_id = s.company_id AND i.holding_id = s.holding_id
			WHERE s.enabled AND s.send_invoices AND s.invoices_from IS NOT NULL${scope}
				AND i.is_active AND i.dte_id IS NOT NULL AND i.dte_folio IS NOT NULL AND i.dte_tipo = ANY ($${params.push(Object.keys(KAME_DOCUMENT_NAMES).map(Number))}::int[])
				AND i.dte_status IN ('aceptado', 'reparos') AND i.issue_date >= s.invoices_from
			ON CONFLICT (system, environment, invoice_id) WHERE object = 'invoice' DO NOTHING
			RETURNING id`,
			params
		);
		const journal = await this.dataSource.query(
			`INSERT INTO erp_exports (holding_id, company_id, system, environment, object, period)
			SELECT s.holding_id, s.company_id, 'kame', s.active_environment, 'journal', m.month::date
			FROM kame_company_settings s
			JOIN kame_connections k ON k.company_id = s.company_id AND k.environment = s.active_environment
			JOIN accounting_period_cutoff c ON c.company_id = s.company_id AND c.holding_id = s.holding_id
			CROSS JOIN LATERAL generate_series(s.journal_from, date_trunc('month', c.cutoff_date)::date, interval '1 month') AS m(month)
			WHERE s.enabled AND s.send_journal AND s.journal_from IS NOT NULL${scope}
			ON CONFLICT (system, environment, company_id, period) WHERE object = 'journal' DO NOTHING
			RETURNING id`,
			params.slice(0, params.length - 1)
		);

		return { invoices: invoices.length, journal: journal.length };
	}

	// ── Enviar ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Envía lo vencido (o los `ids` pedidos). Solo compañías con la conexión activa; una fila `simulated` se vuelve a armar solo cuando la
	 * compañía sale de simulación (así el primer envío real usa los datos del día).
	 */
	async process(options: ProcessOptions = {}): Promise<ProcessResult> {
		await this.recoverStuck(options.holdingId);
		const rows = await this.claim(options);
		const result: ProcessResult = { processed: rows.length, sent: 0, simulated: 0, errors: 0, skipped: 0 };

		for (const row of rows) {
			const outcome = await this.sendOne(row, options.requestedBy ?? null);

			result[outcome] += 1;
		}

		return result;
	}

	/**
	 * Filas que quedaron `sending` más de `STUCK_SENDING_MINUTES` (la API se reinició a mitad de un envío). Una factura vuelve a la cola:
	 * antes de crearla se consulta `getVenta`, así que no se duplica. Una nota de crédito o un mes de asientos no se pueden consultar en
	 * Kame: quedan con error y sin reintento automático, para que alguien revise en Kame si llegaron antes de reintentarlos a mano.
	 */
	async recoverStuck(holdingId?: string): Promise<number> {
		const params: unknown[] = [STUCK_SENDING_MINUTES];
		const scope = holdingId ? ` AND e.holding_id = $${params.push(holdingId)}` : '';
		const rows = await this.dataSource.query(
			`UPDATE erp_exports e SET
				status = CASE WHEN e.object = 'invoice' AND COALESCE(i.dte_tipo, 0) <> 61 THEN 'pending' ELSE 'error' END,
				last_error = CASE WHEN e.object = 'invoice' AND COALESCE(i.dte_tipo, 0) <> 61 THEN e.last_error
					ELSE 'El envío se interrumpió: revisa en Kame si quedó registrado antes de reintentarlo' END,
				next_attempt_at = CASE WHEN e.object = 'invoice' AND COALESCE(i.dte_tipo, 0) <> 61 THEN now() ELSE 'infinity'::timestamptz END,
				updated_at = now()
			FROM erp_exports e2 LEFT JOIN invoices i ON i.id = e2.invoice_id
			WHERE e.id = e2.id AND e.system = 'kame' AND e.status = 'sending' AND e.updated_at < now() - ($1::int * interval '1 minute')${scope}
			RETURNING e.id`,
			params
		);

		if (rows.length) this.logger.warn(`Kame: ${rows.length} envíos interrumpidos se recuperaron`);

		return rows.length;
	}

	/** Toma filas para enviar y las marca `sending` en la misma transacción (otro proceso no las toma dos veces). */
	private async claim(options: ProcessOptions): Promise<ExportRow[]> {
		const params: unknown[] = [];
		const conditions = [
			`e.system = 'kame'`,
			`s.enabled`,
			`e.environment = s.active_environment`,
			options.ids?.length
				? `e.id = ANY ($${params.push(options.ids)}::uuid[]) AND e.status IN ('pending', 'error', 'simulated', 'skipped')`
				: `e.next_attempt_at <= now() AND (e.status IN ('pending', 'error', 'skipped') OR (e.status = 'simulated' AND NOT s.dry_run))`,
			options.holdingId ? `e.holding_id = $${params.push(options.holdingId)}` : null,
			options.companyId ? `e.company_id = $${params.push(options.companyId)}` : null,
		].filter(Boolean);
		const limit = Math.min(options.limit ?? 100, 500);

		return this.dataSource.transaction(async (manager) => {
			const rows: ExportRow[] = await manager.query(
				`SELECT e.id, e.holding_id, e.company_id, e.environment, e.object, e.invoice_id, to_char(e.period, 'YYYY-MM-DD') AS period, e.status, e.attempts
				FROM erp_exports e JOIN kame_company_settings s ON s.company_id = e.company_id
				WHERE ${conditions.join(' AND ')}
				ORDER BY e.next_attempt_at, e.created_at
				LIMIT ${limit}
				FOR UPDATE OF e SKIP LOCKED`,
				params
			);

			if (rows.length)
				await manager.query(`UPDATE erp_exports SET status = 'sending', updated_at = now() WHERE id = ANY ($1::uuid[])`, [
					rows.map((row) => row.id),
				]);

			return rows;
		});
	}

	private async sendOne(row: ExportRow, requestedBy: string | null): Promise<'sent' | 'simulated' | 'errors' | 'skipped'> {
		const settings = await this.connections.findSettings(row.holding_id, row.company_id);
		const connection = await this.connections.findConnection(row.holding_id, row.company_id, row.environment);
		let prepared: Prepared | null = null;

		try {
			if (!settings || !connection)
				throw new KameMappingError(
					`La compañía no tiene conexión de ${KAME_ENVIRONMENT_LABELS[row.environment].toLowerCase()}`,
					'no_connection'
				);
			if (!isKameRutAllowed(connection.kame_company_rut)) {
				throw new KameMappingError('Este entorno solo puede enviar a la empresa de pruebas de Kame', 'rut_not_allowed');
			}
			prepared = row.object === 'invoice' ? await this.prepareInvoice(row, connection) : await this.prepareJournal(row, connection);
			if (prepared === null) {
				await this.finish(row.id, {
					status: 'skipped',
					last_error: 'El mes se reabrió: se enviará cuando vuelva a cerrarse',
					next_attempt_at: new Date(Date.now() + 24 * 60 * 60_000),
					requested_by: requestedBy,
				});

				return 'skipped';
			}
			if (settings.dry_run) {
				await this.finish(row.id, { status: 'simulated', request_payload: prepared.body, last_error: null, requested_by: requestedBy });

				return 'simulated';
			}
			const credential = this.connections.credentialOf(connection);

			// Antes de crear una venta se consulta siempre en Kame: un intento anterior (un corte a mitad, un reintento manual, una fila
			// que quedó «Enviando») pudo haber llegado. Si ya está, no se crea dos veces.
			if (prepared.lookup) {
				const existing = await this.findSale(credential, prepared.lookup);

				if (existing) {
					await this.finish(row.id, {
						status: 'sent',
						request_payload: prepared.body,
						response: existing.raw,
						external_id: existing.id,
						external_folio: String(prepared.lookup.folio),
						sent_at: true,
						last_error: null,
						attempts: row.attempts + 1,
						requested_by: requestedBy,
					});

					return 'sent';
				}
			}
			const written = await this.client.write(credential, prepared.endpoint, prepared.body);

			if (!written.ok) throw new KameApiError(written.error ?? 'Kame rechazó el registro', 200, false, written.raw);
			await this.finish(row.id, {
				status: 'sent',
				request_payload: prepared.body,
				response: written.raw,
				external_id: written.id,
				external_folio: written.folio ?? (prepared.lookup ? String(prepared.lookup.folio) : null),
				sent_at: true,
				last_error: null,
				attempts: row.attempts + 1,
				requested_by: requestedBy,
			});

			return 'sent';
		} catch (error) {
			const message =
				error instanceof KameMappingError || error instanceof KameApiError ? error.message : `Error inesperado: ${(error as Error).message}`;
			const attempts = row.attempts + 1;
			const delay = nextRetryDelay(attempts);

			if (!(error instanceof KameMappingError || error instanceof KameApiError))
				this.logger.error(`Envío a Kame ${row.id}: ${(error as Error).stack}`);
			await this.finish(row.id, {
				status: 'error',
				last_error: message,
				request_payload: prepared?.body ?? null,
				response: error instanceof KameApiError ? (error.response ?? null) : null,
				attempts,
				next_attempt_at: delay === null ? null : new Date(Date.now() + delay),
				requested_by: requestedBy,
			});
			if (delay === null && row.object === 'invoice') await this.notifyFailure(row, prepared?.label ?? null, message);

			return 'errors';
		}
	}

	/** La venta, nota de crédito o nota de débito desde el XML del DTE emitido (api-factura). */
	private async prepareInvoice(row: ExportRow, connection: KameConnectionRow): Promise<Prepared> {
		const [invoice] = await this.dataSource.query(
			`SELECT i.id, i.dte_id, i.dte_tipo, i.dte_folio, i.company_id, c.contract_number
			FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id
			WHERE i.id = $1 AND i.holding_id = $2`,
			[row.invoice_id, row.holding_id]
		);

		if (!invoice?.dte_id) throw new KameMappingError('La factura no tiene documento tributario emitido', 'no_dte');
		const xml = await this.factura.documentoDte(invoice.company_id, invoice.dte_id, 'xml');
		const dte = parseIssuedDte(xml.contenido);
		const request = documentRequest(dte, {
			usuario: connection.user_email,
			unidadNegocio: connection.business_unit,
			sucursal: connection.branch,
			comentario: invoice.contract_number ? `Contrato ${invoice.contract_number} · Sapira` : 'Emitida en Sapira',
		});

		return {
			...request,
			// `getVenta` no documenta la nota de crédito: para esa no hay verificación previa.
			lookup: dte.tipo === 61 ? null : { documento: KAME_DOCUMENT_NAMES[dte.tipo], folio: dte.folio },
			label: `${KAME_DOCUMENT_NAMES[dte.tipo]} N° ${dte.folio}`,
		};
	}

	/** El comprobante de devengo del mes (null si el mes ya no está cerrado). */
	private async prepareJournal(row: ExportRow, connection: KameConnectionRow): Promise<Prepared | null> {
		const month = await this.journalMonth(row.holding_id, row.company_id, row.period!.slice(0, 7));

		if (!month.closed) return null;

		return {
			endpoint: '/Contabilidad/addComprobante',
			body: journalBody(month, {
				usuario: connection.user_email,
				unidadNegocio: connection.business_unit,
				comentario: journalComment(month.period),
			}),
			lookup: null,
			label: `Asientos de ${month.period.slice(0, 7)}`,
		};
	}

	/** Un mes de asientos de la compañía en su moneda (el mismo cálculo de Métricas › Asientos). */
	async journalMonth(holdingId: string, companyId: string, period: string): Promise<JournalMonthInput & { closed: boolean }> {
		if (!PERIOD.test(period)) throw new BadRequestException('El mes va como YYYY-MM');
		const journal = await this.revenue.journal(holdingId, { companyId, from: period, to: period } as RevenueJournalDto);
		const month = journal.months.find((candidate) => String(candidate.period).slice(0, 7) === period);

		if (journal.currency !== 'CLP')
			throw new KameMappingError(`Los asientos de la compañía están en ${journal.currency} y Kame lleva pesos`, 'currency_not_clp');

		return {
			period: `${period}-01`,
			closed: Boolean(month?.closed),
			postings: (month?.postings ?? []).map((posting) => ({
				account: posting.account,
				debit: posting.debit,
				credit: posting.credit,
				name: posting.name ?? null,
				external_code: posting.external_code ?? null,
			})),
		};
	}

	/** Vista previa del comprobante de un mes, sin enviar nada: el cuerpo, si cuadra y qué falta. */
	async previewJournal(holdingId: string, companyId: string, period: string) {
		await this.connections.assertCompany(holdingId, companyId);
		const month = await this.journalMonth(holdingId, companyId, period);
		const settings = await this.connections.findSettings(holdingId, companyId);
		const connection = settings ? await this.connections.findConnection(holdingId, companyId, settings.active_environment) : null;

		try {
			const body = journalBody(month, {
				usuario: connection?.user_email ?? '',
				unidadNegocio: connection?.business_unit ?? null,
				comentario: journalComment(month.period),
			});
			const total = body.detalle.reduce((sum, line) => sum + line.debe, 0);

			return { period, closed: month.closed, ok: true, error: null, total, body };
		} catch (error) {
			if (error instanceof KameMappingError) return { period, closed: month.closed, ok: false, error: error.message, total: 0, body: null };
			throw error;
		}
	}

	/** Envía ya los asientos de un mes cerrado (lo encola si no estaba). Respeta la simulación de la compañía. */
	async sendJournalNow(holdingId: string, companyId: string, period: string, requestedBy: string | null) {
		await this.connections.assertCompany(holdingId, companyId);
		const settings = await this.requireActive(holdingId, companyId);
		const month = await this.journalMonth(holdingId, companyId, period);

		if (!month.closed) throw new BadRequestException(`El mes ${period} no está cerrado: cierra el período antes de enviar sus asientos`);
		const [row] = await this.dataSource.query(
			`INSERT INTO erp_exports (holding_id, company_id, system, environment, object, period, requested_by)
			VALUES ($1, $2, 'kame', $3, 'journal', $4::date, $5)
			ON CONFLICT (system, environment, company_id, period) WHERE object = 'journal'
			DO UPDATE SET status = CASE WHEN erp_exports.status = 'sent' THEN 'sent' ELSE 'pending' END, next_attempt_at = now(), updated_at = now()
			RETURNING id, status`,
			[holdingId, companyId, settings.active_environment, `${period}-01`, requestedBy]
		);

		if (row.status === 'sent')
			throw new BadRequestException(
				`Los asientos de ${period} ya están en Kame (${KAME_ENVIRONMENT_LABELS[settings.active_environment].toLowerCase()})`
			);
		await this.process({ ids: [row.id], requestedBy });

		return this.exportById(holdingId, row.id);
	}

	/** «Enviar ahora»: encola y envía lo pendiente del holding (o de una compañía), sin esperar al job. No mira el interruptor automático. */
	async sendNow(holdingId: string, companyId: string | undefined, requestedBy: string | null) {
		if (companyId) await this.connections.assertCompany(holdingId, companyId);
		const enqueued = await this.enqueue(holdingId, companyId);
		const result = await this.process({ holdingId, companyId, requestedBy });

		return { enqueued, ...result };
	}

	/** Reintenta ya los envíos pedidos (con error, simulados u omitidos), desde cero intentos. */
	async retry(holdingId: string, ids: string[], requestedBy: string | null) {
		const rows = await this.dataSource.query(
			`UPDATE erp_exports SET attempts = 0, next_attempt_at = now(), updated_at = now()
			WHERE holding_id = $1 AND id = ANY ($2::uuid[]) AND status IN ('error', 'simulated', 'skipped') RETURNING id`,
			[holdingId, ids]
		);

		if (rows.length === 0) throw new NotFoundException('No hay envíos con error para reintentar');

		return this.process({ holdingId, ids: rows.map((row: { id: string }) => row.id), requestedBy });
	}

	// ── Lectura ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async list(
		holdingId: string,
		query: { company_id?: string; object?: string; status?: string; environment?: string; page?: number; limit?: number }
	) {
		const params: unknown[] = [holdingId];
		const conditions = [`e.holding_id = $1`, `e.system = 'kame'`];

		if (query.company_id) conditions.push(`e.company_id = $${params.push(query.company_id)}`);
		if (query.object) conditions.push(`e.object = $${params.push(query.object)}`);
		if (query.status) conditions.push(`e.status = ANY ($${params.push(query.status.split(','))}::text[])`);
		if (query.environment) conditions.push(`e.environment = $${params.push(query.environment)}`);
		const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
		const page = Math.max(query.page ?? 1, 1);
		const where = conditions.join(' AND ');
		const [rows, [{ total }]] = await Promise.all([
			this.dataSource.query(
				`${this.selectSql()} WHERE ${where} ORDER BY e.updated_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
				params
			),
			this.dataSource.query(`SELECT COUNT(*)::int AS total FROM erp_exports e WHERE ${where}`, params),
		]);

		return { data: rows, total, currentPage: page, pages: Math.max(1, Math.ceil(total / limit)), limit };
	}

	async exportById(holdingId: string, id: string) {
		const [row] = await this.dataSource.query(`${this.selectSql()} WHERE e.holding_id = $1 AND e.id = $2`, [holdingId, id]);

		if (!row) throw new NotFoundException('Envío no encontrado');

		return row;
	}

	private selectSql() {
		return `SELECT e.id, e.company_id::text AS company_id, co.legal_name AS company_name, e.environment, e.object, e.invoice_id,
				to_char(e.period, 'YYYY-MM') AS period, e.status, e.attempts, e.next_attempt_at, e.external_id, e.external_folio, e.last_error,
				e.request_payload, e.sent_at, e.created_at, e.updated_at,
				i.invoice_number, i.dte_tipo, i.issue_date, i.total_invoice_currency AS total, i.contract_id, c.contract_number, cl.name_commercial AS client_name
			FROM erp_exports e
			JOIN companies co ON co.id = e.company_id
			LEFT JOIN invoices i ON i.id = e.invoice_id
			LEFT JOIN contracts c ON c.id = i.contract_id
			LEFT JOIN clients cl ON cl.id = i.client_id`;
	}

	// ── Internos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async requireActive(holdingId: string, companyId: string): Promise<KameSettingsRow> {
		const settings = await this.connections.findSettings(holdingId, companyId);

		if (!settings?.enabled) throw new BadRequestException('Activa la conexión de la compañía con Kame antes de enviar');

		return settings;
	}

	private async findSale(credential: ReturnType<KameConnectionsService['credentialOf']>, lookup: { documento: string; folio: number }) {
		try {
			const raw = (await this.client.getSale(credential, lookup.documento, lookup.folio)) as Record<string, unknown> | null;
			const id = raw?.IdVenta ?? raw?.Id ?? raw?.id ?? null;

			return raw && id != null ? { id: String(id), raw } : null;
		} catch (error) {
			if (error instanceof KameApiError && error.status === 404) return null;
			if (error instanceof KameApiError && !error.retryable) return null;
			throw error;
		}
	}

	private async finish(
		id: string,
		values: {
			status: string;
			last_error?: string | null;
			request_payload?: unknown;
			response?: unknown;
			external_id?: string | null;
			external_folio?: string | null;
			sent_at?: boolean;
			attempts?: number;
			next_attempt_at?: Date | null;
			requested_by?: string | null;
		}
	) {
		await this.dataSource.query(
			`UPDATE erp_exports SET status = $2, last_error = $3,
				request_payload = COALESCE($4::jsonb, request_payload), response = COALESCE($5::jsonb, response),
				external_id = COALESCE($6, external_id), external_folio = COALESCE($7, external_folio),
				sent_at = CASE WHEN $8 THEN now() ELSE sent_at END, attempts = COALESCE($9, attempts),
				next_attempt_at = CASE WHEN $10::boolean THEN 'infinity'::timestamptz ELSE COALESCE($11::timestamptz, next_attempt_at) END,
				requested_by = COALESCE($12, requested_by), updated_at = now()
			WHERE id = $1`,
			[
				id,
				values.status,
				values.last_error ?? null,
				values.request_payload === undefined || values.request_payload === null ? null : JSON.stringify(values.request_payload),
				values.response === undefined || values.response === null ? null : JSON.stringify(values.response),
				values.external_id ?? null,
				values.external_folio ?? null,
				values.sent_at === true,
				values.attempts ?? null,
				values.next_attempt_at === null,
				values.next_attempt_at ?? null,
				values.requested_by ?? null,
			]
		);
	}

	/** Aviso cuando una factura agota los reintentos: el mismo tipo que el envío de facturas al ERP (Notificaciones). */
	private async notifyFailure(row: ExportRow, label: string | null, message: string) {
		try {
			const [invoice] = await this.dataSource.query(
				`SELECT i.id, i.contract_id, i.invoice_number, cl.name_commercial AS client_name
				FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id WHERE i.id = $1 AND i.holding_id = $2`,
				[row.invoice_id, row.holding_id]
			);

			if (!invoice) return;
			await this.notifications.createOrUpdate(row.holding_id, {
				source: 'invoices',
				type: INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE,
				severity: 'error',
				title: `No se pudo registrar ${label ?? `la factura ${invoice.invoice_number ?? ''}`} de ${invoice.client_name ?? 'el cliente'} en el ERP`,
				message,
				recommendation: 'Revisa el envío en Integraciones › ERP › Kame y vuelve a intentarlo.',
				action_type: 'open_contract',
				action_payload: { contract_id: invoice.contract_id },
				resource_type: 'invoice',
				resource_id: invoice.id,
				metadata: { system: 'kame', environment: row.environment, export_id: row.id, contract_id: invoice.contract_id },
				deduplication_key: `invoice-kame-failure:${invoice.id}:${row.environment}`,
			} as Parameters<NotificationsService['createOrUpdate']>[1]);
		} catch (error) {
			this.logger.error(`No se pudo crear el aviso del envío a Kame ${row.id}: ${(error as Error).message}`);
		}
	}
}

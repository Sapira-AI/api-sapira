import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { setApiWriter } from './api-writer';
import { refreshInvoiceSystemAmounts } from './api-written-fields';
import { CANCELLED_STATUS, PENDING_STATUS } from './contract-360';
import { resolveUserId } from './contract-drafts.service';
import { type InvoiceBlocker } from './contract-invoices';
import { ContractsService } from './contracts.service';
import {
	candidateView,
	CONSOLIDATED_INVOICE_TYPE,
	CONSOLIDATION_EVENT_TYPES,
	type ConsolidationContext,
	type ConsolidationInvoice,
	type ConsolidationLine,
	type ConsolidationPlan,
	type ConsolidationReference,
	type CopyLineKey,
	invoiceBlockers,
	keptUnifiedDates,
	keptUnifiedDescriptions,
	planConsolidation,
	undoBlockers,
	UNIFIED_INVOICE_TYPES,
	type UnifiedDates,
} from './invoice-consolidation';
import { DESCRIPTION_LIMITS_SQL, descriptionMaxCharsOfRow } from './tax-document-types';

import type { ConsolidateInvoicesDto, UndoConsolidationDto } from './dtos/contract-invoice-consolidation.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** Máximo de candidatas que devuelve la búsqueda (el documento admite 50). */
export const CANDIDATES_LIMIT = 100;

/** Factura (de cualquier contrato del holding) con lo que usan las reglas de consolidación. */
const INVOICE_SQL = `SELECT i.id, i.invoice_number, i.contract_id, c.contract_number, i.client_id, cl.name_commercial AS client_name,
		i.status, i.document_type, i.invoice_type, i.is_active, i.is_legacy, i.consolidated_into_invoice_id, i.company_id, i.client_entity_id,
		ce.legal_name, i.invoice_currency, i.contract_currency, i.issue_date::text AS issue_date, i.scheduled_at::text AS scheduled_at,
		i.due_date::text AS due_date, COALESCE(i.export_type, 0) AS export_type, i.invoice_series, i.tax_rate,
		i.amount_contract_currency, i.vat, i.amount_invoice_currency, i.total_invoice_currency, i.amount_system_currency, i.total_system_currency,
		i.odoo_invoice_id, i.sent_to_odoo_at, i.auto_invoice, i.requires_references_for_billing,
		COALESCE(c.requires_references_for_billing, false) AS contract_requires_references, c.auto_send_to_odoo,
		COALESCE(l.lines_count, 0) AS lines_count, COALESCE(l.internal_lines, 0) AS internal_lines, COALESCE(l.open_lines, 0) AS open_lines,
		public.get_cutoff_date(i.holding_id, i.company_id)::text AS cutoff_date
	FROM invoices i
	LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
	LEFT JOIN clients cl ON cl.id = i.client_id
	LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
	LEFT JOIN LATERAL (
		SELECT COUNT(*) AS lines_count, COUNT(*) FILTER (WHERE ii.visible_line_id IS NOT NULL) AS internal_lines,
			COUNT(*) FILTER (WHERE ii.quantity_source IN ('pending', 'estimated')) AS open_lines
		FROM invoice_items ii WHERE ii.invoice_id = i.id
	) l ON true`;

/** Candidatas: Por Emitir activas de OTROS contratos que calzan con la base en compañía, receptor, moneda, mes, documento y exportación. */
const CANDIDATES_SQL = `${INVOICE_SQL}
	WHERE i.holding_id = $1 AND i.id <> $2::uuid AND i.contract_id IS NOT NULL AND i.contract_id <> $3::uuid
		AND i.status = '${PENDING_STATUS}' AND i.is_active = true AND i.consolidated_into_invoice_id IS NULL
		AND COALESCE(i.invoice_type, '') NOT IN (${UNIFIED_INVOICE_TYPES.map((type) => `'${type}'`).join(', ')})
		AND COALESCE(i.is_legacy, false) = false AND COALESCE(i.document_type, 'FACTURA') NOT IN ('NC', 'ND')
		AND i.company_id IS NOT DISTINCT FROM $4::uuid AND i.client_entity_id = $5::uuid AND UPPER(i.invoice_currency) = UPPER($6)
		AND date_trunc('month', COALESCE(i.issue_date, i.scheduled_at)) = date_trunc('month', $7::date)
		AND COALESCE(i.document_type, 'FACTURA') = $8 AND COALESCE(i.export_type, 0) = $9
	ORDER BY COALESCE(i.issue_date, i.scheduled_at), c.contract_number, i.id
	LIMIT ${CANDIDATES_LIMIT}`;

const LINES_SQL = `SELECT ii.id, ii.invoice_id, COALESCE(ii.contract_id, ci.contract_id) AS contract_id, ii.contract_item_id, ii.description, ci.product_name,
		ii.contract_currency, ii.quantity, ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency,
		ii.total_contract_currency, ii.unit_price_invoice_currency, ii.subtotal_invoice_currency, ii.tax_amount_invoice_currency,
		ii.total_invoice_currency, ii.fx_contract_to_invoice, ii.fx_rate_source, ii.fx_rate_date::text AS fx_rate_date,
		ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end
	FROM invoice_items ii LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
	WHERE ii.invoice_id = ANY($1::uuid[]) AND ii.holding_id = $2
	ORDER BY ii.billing_period_start NULLS LAST, ii.created_at, ii.id`;

const REFERENCES_SQL = `SELECT r.id, 'invoice' AS source, r.invoice_id, r.document_type_code AS type, r.document_type_name AS name, r.document_number AS code
	FROM invoice_references r WHERE r.invoice_id = ANY($1::uuid[]) AND r.holding_id = $2
	UNION ALL
	SELECT br.id, 'contract' AS source, rl.invoice_id, br.reference_type::text AS type, NULL AS name, br.reference_code AS code
	FROM invoice_reference_links rl JOIN billing_references br ON br.id = rl.reference_id
	WHERE rl.invoice_id = ANY($1::uuid[]) AND rl.holding_id = $2`;

/** Límite de la glosa de cada contrato (mismas fuentes que el editor: documento del catálogo o el de la familia en el país). */
const LIMITS_SQL = `SELECT c.id, c.tax_document_type_id, tdt.description_max_chars AS own_description_max_chars, co.country AS company_country,
		c.document_type, ${DESCRIPTION_LIMITS_SQL} AS description_limits
	FROM contracts c
	LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
	LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
	WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2`;

/** Columnas de `copyLineKey` sobre `invoice_items ii` (la fila del tramo sale del desglose). */
const COPY_KEY_SQL = `ii.contract_id, ii.contract_item_id, ii.billing_period_start::text AS billing_period_start,
	ii.billing_period_end::text AS billing_period_end,
	CASE WHEN jsonb_typeof(ii.pricing_breakdown) = 'array' THEN ii.pricing_breakdown->0->>'line_index' END AS tier_index`;

const EVENT_SQL = `SELECT e.id, e.metadata FROM contract_lifecycle_events e
	WHERE e.holding_id = $1 AND e.event_type = '${CONSOLIDATION_EVENT_TYPES.consolidated}' AND e.metadata->>'consolidated_invoice_id' = $2::text
	ORDER BY e.created_at DESC LIMIT 1`;

export type ConsolidationPreview = ConsolidationPlan;

/** Opciones de `applyInvoices`: notas (manual) o principal, regla y origen (unificación recurrente). */
export interface ApplyOptions {
	notes?: string | null;
	main_contract_id?: string | null;
	rule_id?: string | null;
	source?: string;
}

/** Lo que la unificada anterior traspasa a la nueva al re-unificar (`reunifyInvoices`). */
interface UnifiedCarry {
	previous_id: string;
	/** Fechas de la anterior: si se reprogramó, la nueva las conserva (`keptUnifiedDates`). */
	dates: UnifiedDates | null;
	references: ConsolidationReference[];
	locked: Array<CopyLineKey & { description: string | null }>;
}

/**
 * Consolidación opcional entre contratos (caso socio, `docs/v2-rediseno/spec-multimoneda-contrato.md` §7): candidatas, preview, aplicar y
 * deshacer. Plan puro en `invoice-consolidation.ts`. Aplicar va en **una transacción** con `setApiWriter` como primera sentencia, los
 * contratos involucrados bloqueados (`FOR UPDATE`, en orden de id) y las facturas también; crea un documento `Unificada` (grupo propio) con
 * **copias** de las líneas de los orígenes (glosa con el número de contrato al final, `contract_id` de la línea, tasa por par; spot entero si alguna línea lo es),
 * copia las referencias OC/HES sin repetir tipo+folio, deja los orígenes `is_active = false` con `consolidated_into_invoice_id` y registra
 * un evento `INVOICE_CONSOLIDATED` por contrato. Deshacer: el consolidado pasa a `Cancelada` (nunca DELETE) y los orígenes vuelven intactos.
 * El devengo no cambia (las copias llevan el mismo `contract_item_id` y monto que el origen, que queda inactivo): sin rebuild. Nunca escribe
 * `invoices.updated_at`. Un consumo posterior sobre un origen re-copia sus líneas con `resyncFromOrigins`.
 */
@Injectable()
export class ContractInvoiceConsolidationService {
	private readonly logger = new Logger(ContractInvoiceConsolidationService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService
	) {}

	// ---------------------------------------------------------------- candidatas

	/**
	 * `GET /contracts/:id/invoices/:invoiceId/consolidation-candidates`: la factura base (y por qué ella misma no se podría consolidar) y las
	 * Por Emitir de otros contratos que calzan con ella, cada una con sus bloqueos (`eligible` = sin bloqueos).
	 */
	async candidates(idOrNumber: string, invoiceId: string, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const [base] = await this.loadInvoices(this.dataSource, holdingId, [invoiceId]);

		if (base.contract_id !== contract.id) throw new NotFoundException('Factura no encontrada');
		const month = base.issue_date ?? base.scheduled_at;
		const rows =
			base.client_entity_id && month
				? ((await this.dataSource.query(CANDIDATES_SQL, [
						holdingId,
						base.id,
						contract.id,
						base.company_id,
						base.client_entity_id,
						base.invoice_currency ?? '',
						month,
						base.document_type || 'FACTURA',
						base.export_type,
					])) as Row[])
				: [];
		const candidates = rows.map((row) => candidateView(base, this.invoiceOf(row)));
		const baseView = candidateView(base, base);

		return {
			invoice: { ...baseView, blockers: invoiceBlockers(base), eligible: invoiceBlockers(base).length === 0 },
			base_blockers: invoiceBlockers(base),
			candidates,
			total: candidates.length,
		};
	}

	// ---------------------------------------------------------------- preview y aplicar

	/** Vista previa. La unificación recurrente fija el principal (encabezado y fecha de emisión). */
	async preview(dto: ConsolidateInvoicesDto, holdingId: string, mainContractId: string | null = null): Promise<ConsolidationPreview> {
		const ctx = await this.loadContext(this.dataSource, holdingId, dto.invoice_ids);

		return planConsolidation({ ...ctx, main_contract_id: mainContractId });
	}

	/** Aplica la consolidación. 409 `blocked` con `blockers[]` y el preview; devuelve el preview más `applied`, el id nuevo y los eventos. */
	async apply(dto: ConsolidateInvoicesDto, holdingId: string, authId: string, today = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.applyInvoices(dto.invoice_ids, holdingId, userId, { notes: dto.notes?.trim() || null }, today);
	}

	/**
	 * Consolidación de un conjunto de Por Emitir. La usan la acción manual (`apply`) y la unificación recurrente de una razón social
	 * (`InvoiceConsolidationRulesService`), que fija el contrato principal (`main_contract_id`: encabezado y fecha de emisión), marca los
	 * eventos con `rule_id` y puede correr sin usuario (job diario: `userId` null).
	 */
	async applyInvoices(invoiceIds: string[], holdingId: string, userId: string | null, options: ApplyOptions = {}, today = new Date()) {
		const contractIds = await this.contractIdsOf(this.dataSource, holdingId, invoiceIds);
		const result = await this.transaction(contractIds, holdingId, (runner) =>
			this.applyIn(runner, invoiceIds, holdingId, userId, options, today, contractIds)
		);

		return await this.appliedView(result, holdingId);
	}

	/**
	 * Re-unificar un mes (unificación recurrente, apareció una factura nueva): deshace la unificada anterior y arma la nueva con
	 * `invoiceIds` en **una sola transacción**, y traspasa a la nueva lo que la usuaria le agregó a la anterior (Domi 07-10): sus
	 * referencias OC/HES (propias y vinculadas del contrato, sin repetir tipo+folio con las de los orígenes) y las glosas escritas a mano en
	 * sus líneas (`description_locked`, emparejadas por ítem, período y fila de tramo como en `resyncFromOrigins`); si estaba reprogramada,
	 * también su emisión, fecha programada y vencimiento (`keptUnifiedDates`). Si algo bloquea, nada
	 * cambia (rollback): la anterior sigue vigente.
	 */
	async reunifyInvoices(
		previousId: string,
		invoiceIds: string[],
		reason: string,
		holdingId: string,
		userId: string | null,
		options: ApplyOptions = {},
		today = new Date()
	) {
		const [previous] = await this.loadInvoices(this.dataSource, holdingId, [previousId]);
		const previousOrigins = await this.loadOrigins(this.dataSource, holdingId, previousId);
		const contractIds = [
			...new Set(
				[
					previous.contract_id,
					...previousOrigins.map((origin) => origin.contract_id),
					...(await this.contractIdsOf(this.dataSource, holdingId, invoiceIds)),
				].filter((id): id is string => !!id)
			),
		];
		const result = await this.transaction(contractIds, holdingId, async (runner) => {
			const carry = await this.carryFrom(runner, holdingId, previousId);
			const undone = await this.undoIn(runner, previousId, reason, holdingId, userId, today, options.source);
			const applied = await this.applyIn(runner, invoiceIds, holdingId, userId, options, today, contractIds, carry);

			return { ...applied, undone, carried: { references: carry.references.length, descriptions: applied.kept_descriptions } };
		});

		return { ...(await this.appliedView(result, holdingId)), undone: result.undone, carried: result.carried };
	}

	/** Lo que la unificada anterior lleva a la nueva al re-unificar: fechas, referencias (propias y vinculadas) y glosas protegidas. */
	private async carryFrom(runner: QueryRunner, holdingId: string, previousId: string): Promise<UnifiedCarry> {
		const [[previous], references, locked] = await Promise.all([
			this.loadInvoices(runner, holdingId, [previousId]),
			runner.query(REFERENCES_SQL, [[previousId], holdingId]) as Promise<Row[]>,
			runner.query(
				`SELECT ${COPY_KEY_SQL}, ii.description FROM invoice_items ii WHERE ii.invoice_id = $1 AND ii.holding_id = $2 AND ii.description_locked = true`,
				[previousId, holdingId]
			) as Promise<Row[]>,
		]);

		return {
			previous_id: previousId,
			dates: previous ? { issue_date: previous.issue_date, scheduled_at: previous.scheduled_at, due_date: previous.due_date } : null,
			references: references.map((row) => this.referenceOf(row)),
			locked: locked.map((row) => ({ ...this.copyKeyOf(row), description: toText(row.description) })),
		};
	}

	/** Consolidación dentro de una transacción ya abierta (costura y contratos bloqueados). `carry`: lo heredado al re-unificar. */
	private async applyIn(
		runner: QueryRunner,
		invoiceIds: string[],
		holdingId: string,
		userId: string | null,
		options: ApplyOptions,
		today: Date,
		contractIds: string[],
		carry: UnifiedCarry | null = null
	) {
		const dto = { invoice_ids: invoiceIds, notes: options.notes ?? undefined } as ConsolidateInvoicesDto;

		await this.lockInvoices(runner, holdingId, dto.invoice_ids);
		const ctx = await this.loadContext(runner, holdingId, dto.invoice_ids);
		const planned = planConsolidation({
			...ctx,
			main_contract_id: options.main_contract_id ?? null,
			carried_references: carry?.references ?? [],
		});
		// Re-unificar: si la anterior estaba reprogramada, la nueva conserva su emisión, fecha programada y vencimiento.
		const dates = keptUnifiedDates(planned.header, carry?.dates ?? null);
		const plan = dates.kept ? { ...planned, header: dates.header } : planned;
		const changed = ctx.invoices.some((invoice) => invoice.contract_id && !contractIds.includes(invoice.contract_id));

		if (changed)
			throw this.blocked(
				[
					{
						code: 'concurrent_change',
						message: 'Las facturas cambiaron de contrato mientras se consolidaban',
						next_step: 'Vuelve a intentarlo',
					},
				],
				plan
			);
		if (plan.blockers.length) throw this.blocked(plan.blockers, plan);
		const kept = carry?.locked.length ? await this.keptDescriptions(runner, holdingId, carry.locked, plan) : new Map<string, string>();
		const consolidatedId = await this.write(runner, holdingId, plan, dto, userId, kept);
		const sourceIds = plan.invoices.map((invoice) => invoice.id);
		const eventIds: string[] = [];

		for (const contribution of plan.contributions) {
			eventIds.push(
				await this.insertEvent(runner, holdingId, userId, contribution.contract_id, CONSOLIDATION_EVENT_TYPES.consolidated, isoDate(today), {
					title: 'Facturas consolidadas en un documento',
					description: `${sourceIds.length} facturas de ${plan.contributions.length} contratos consolidadas${
						contribution.main ? ' (contrato principal)' : ''
					}`,
					metadata: {
						invoice_id: consolidatedId,
						invoice_ids: [consolidatedId, ...sourceIds],
						consolidated_invoice_id: consolidatedId,
						source_invoice_ids: sourceIds,
						contract_source_invoice_ids: contribution.invoice_ids,
						main_contract_id: plan.main_contract_id,
						contracts: plan.contributions.map((entry) => ({
							contract_id: entry.contract_id,
							contract_number: entry.contract_number,
							client_id: entry.client_id,
							invoice_ids: entry.invoice_ids,
							subtotal_invoice_currency: entry.subtotal_invoice_currency,
							subtotal_by_currency: entry.subtotal_by_currency,
							main: entry.main,
						})),
						header: {
							invoice_currency: plan.header.invoice_currency,
							contract_currency: plan.header.contract_currency,
							amount_contract_currency: plan.header.amount_contract_currency,
							amount_invoice_currency: plan.header.amount_invoice_currency,
							total_invoice_currency: plan.header.total_invoice_currency,
							fx_contract_to_invoice: plan.header.fx_contract_to_invoice,
							spot: plan.header.spot,
							pairs: plan.header.pairs,
						},
						references: plan.references.items,
						notes: dto.notes?.trim() || null,
						warnings: plan.warnings.map((warning) => warning.code),
						...(options.rule_id ? { rule_id: options.rule_id } : {}),
						...(options.source ? { source: options.source } : {}),
						...(carry
							? { previous_consolidated_invoice_id: carry.previous_id, kept_descriptions: kept.size, kept_dates: dates.kept }
							: {}),
					},
				})
			);
		}

		return { plan, consolidatedId, eventIds, kept_descriptions: kept.size };
	}

	private async appliedView(result: { plan: ConsolidationPlan; consolidatedId: string; eventIds: string[] }, holdingId: string) {
		return {
			...result.plan,
			applied: true,
			consolidated_invoice_id: result.consolidatedId,
			event_ids: result.eventIds,
			invoice: result.plan.main_contract_id
				? await this.contracts.invoiceDetail(result.plan.main_contract_id, result.consolidatedId, holdingId)
				: null,
		};
	}

	// ---------------------------------------------------------------- deshacer

	/**
	 * `POST /contracts/invoices/consolidations/:invoiceId/undo`: solo un consolidado v2 (con evento `INVOICE_CONSOLIDATED`) Por Emitir y sin
	 * borrador en el ERP. El consolidado pasa a `Cancelada` (se conserva con sus líneas) y los orígenes vuelven a `is_active = true` sin
	 * `consolidated_into_invoice_id`; un evento `INVOICE_CONSOLIDATION_UNDONE` por contrato. 409 `blocked` (p. ej. `legacy_unified`).
	 */
	async undo(invoiceId: string, dto: UndoConsolidationDto, holdingId: string, authId: string, today = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.undoInvoice(invoiceId, dto.reason, holdingId, userId, today);
	}

	/** Deshacer sin pasar por el DTO: lo usan `undo` y la unificación recurrente (re-unificar o pausar la regla; `userId` null en el job). */
	async undoInvoice(invoiceId: string, reason: string, holdingId: string, userId: string | null, today = new Date(), source?: string) {
		const [consolidated] = await this.loadInvoices(this.dataSource, holdingId, [invoiceId]);
		const origins = await this.loadOrigins(this.dataSource, holdingId, invoiceId);
		const contractIds = [
			...new Set([consolidated.contract_id, ...origins.map((origin) => origin.contract_id)].filter((id): id is string => !!id)),
		];

		return await this.transaction(contractIds, holdingId, (runner) => this.undoIn(runner, invoiceId, reason, holdingId, userId, today, source));
	}

	/** Deshacer dentro de una transacción ya abierta (costura y contratos bloqueados). */
	private async undoIn(
		runner: QueryRunner,
		invoiceId: string,
		reason: string,
		holdingId: string,
		userId: string | null,
		today: Date,
		source?: string
	) {
		const dto = { reason } as UndoConsolidationDto;
		const origins = await this.loadOrigins(runner, holdingId, invoiceId);

		await this.lockInvoices(runner, holdingId, [invoiceId, ...origins.map((origin) => origin.id)]);
		const [current] = await this.loadInvoices(runner, holdingId, [invoiceId]);
		const currentOrigins = await this.loadOrigins(runner, holdingId, invoiceId);
		const [event] = (await runner.query(EVENT_SQL, [holdingId, invoiceId])) as Row[];
		const preview = {
			consolidated: { id: current.id, invoice_number: current.invoice_number, status: current.status, contract_id: current.contract_id },
			origins: currentOrigins.map((origin) => ({
				id: origin.id,
				invoice_number: origin.invoice_number,
				contract_id: origin.contract_id,
				contract_number: origin.contract_number,
			})),
		};
		const blockers = undoBlockers(current, !!event, currentOrigins.length);

		if (blockers.length) throw this.blocked(blockers, preview);
		await runner.query(`UPDATE invoices SET status = '${CANCELLED_STATUS}' WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`, [
			invoiceId,
			holdingId,
		]);
		const restored = (await runner.query(
			`UPDATE invoices SET is_active = true, consolidated_into_invoice_id = NULL
			WHERE consolidated_into_invoice_id = $1 AND holding_id = $2 RETURNING id`,
			[invoiceId, holdingId]
		)) as Row[];
		const restoredIds = restored.map((row) => String(row.id));
		const byContract = new Map<string, string[]>();

		for (const origin of currentOrigins)
			if (origin.contract_id) byContract.set(origin.contract_id, [...(byContract.get(origin.contract_id) ?? []), origin.id]);
		const eventIds: string[] = [];

		for (const [contractId, ids] of byContract) {
			eventIds.push(
				await this.insertEvent(runner, holdingId, userId, contractId, CONSOLIDATION_EVENT_TYPES.undone, isoDate(today), {
					title: 'Consolidación de facturas deshecha',
					description: `Documento consolidado ${current.invoice_number ?? current.id} cancelado; ${restoredIds.length} facturas restauradas`,
					metadata: {
						invoice_id: invoiceId,
						invoice_ids: [invoiceId, ...restoredIds],
						consolidated_invoice_id: invoiceId,
						source_invoice_ids: restoredIds,
						contract_source_invoice_ids: ids,
						contracts: [...byContract.entries()].map(([id, invoiceIds]) => ({ contract_id: id, invoice_ids: invoiceIds })),
						reason: dto.reason.trim(),
						...(source ? { source } : {}),
					},
				})
			);
		}

		return {
			...preview,
			undone: true,
			consolidated_invoice_id: invoiceId,
			status: CANCELLED_STATUS,
			restored_invoice_ids: restoredIds,
			event_ids: eventIds,
		};
	}

	// ---------------------------------------------------------------- escritura

	/** Encabezado, líneas copiadas, referencias y orígenes. Devuelve el id del consolidado. */
	private async write(
		runner: QueryRunner,
		holdingId: string,
		plan: ConsolidationPlan,
		dto: ConsolidateInvoicesDto,
		userId: string | null,
		kept: Map<string, string> = new Map()
	): Promise<string> {
		const header = plan.header;
		const [row] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
				scheduled_at, original_issue_date, issue_date, due_date,
				vat, tax_rate, amount_contract_currency, amount_invoice_currency, total_invoice_currency,
				contract_currency, invoice_currency, fx_contract_to_invoice, system_currency, amount_system_currency, total_system_currency,
				status, invoice_type, document_type, export_type, invoice_series,
				holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id, payment_method, fiscal_regime,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, notes, is_active
			) SELECT
				g.id, g.id, o.company_id, o.client_id, o.client_entity_id, $3::uuid,
				$4::date, $4::date, $5::date, $6::date,
				$7, o.tax_rate, $8, $9, $10,
				$11, $12, $13, o.system_currency, $14, $15,
				'${PENDING_STATUS}', '${CONSOLIDATED_INVOICE_TYPE}', o.document_type, o.export_type, o.invoice_series,
				o.holding_id, o.issuer_legal_name, o.issuer_tax_id, o.issuer_address, o.client_tax_id, o.payment_method, o.fiscal_regime,
				$16, $17, o.invoice_terms_and_conditions, $18, true
			FROM invoices o CROSS JOIN (SELECT gen_random_uuid() AS id) g
			WHERE o.id = $1::uuid AND o.holding_id = $2
			RETURNING id`,
			[
				header.template_invoice_id,
				holdingId,
				header.contract_id,
				header.scheduled_at,
				header.issue_date,
				header.due_date,
				header.vat,
				header.amount_contract_currency,
				header.amount_invoice_currency,
				header.total_invoice_currency,
				header.contract_currency,
				header.invoice_currency,
				header.fx_contract_to_invoice,
				header.amount_system_currency,
				header.total_system_currency,
				header.requires_references_for_billing,
				header.auto_invoice,
				dto.notes?.trim() || null,
			]
		)) as Row[];
		const consolidatedId = String(row.id);

		// Líneas: copias (los orígenes quedan intactos para deshacer) con la glosa y el número de contrato al final, `contract_id` y montos/tasa.
		await this.insertCopies(runner, consolidatedId, plan, header.invoice_currency, header.issue_date, holdingId, kept);

		// Referencias OC/HES de los orígenes (y, al re-unificar, las de la unificada anterior) sin repetir tipo+folio: las propias se copian;
		// las del contrato se vinculan.
		if (plan.references.invoice_reference_ids.length) {
			await runner.query(
				`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_code, reason, reference_date, created_by)
				SELECT $1, r.holding_id, r.document_number, r.document_type_code, r.document_type_name, r.reference_code, r.reason, r.reference_date, r.created_by
				FROM invoice_references r WHERE r.id = ANY($2::uuid[]) AND r.holding_id = $3`,
				[consolidatedId, plan.references.invoice_reference_ids, holdingId]
			);
		}
		if (plan.references.contract_reference_ids.length) {
			await runner.query(
				`INSERT INTO invoice_reference_links (invoice_id, reference_id, holding_id, linked_by)
				SELECT $1, br.id, br.holding_id, $4 FROM billing_references br WHERE br.id = ANY($2::uuid[]) AND br.holding_id = $3
				ON CONFLICT (invoice_id, reference_id) DO NOTHING`,
				[consolidatedId, plan.references.contract_reference_ids, holdingId, userId]
			);
		}

		// Orígenes: inactivos y apuntando al consolidado (siguen Por Emitir; deshacer los devuelve tal cual).
		await runner.query(
			`UPDATE invoices SET is_active = false, consolidated_into_invoice_id = $1
			WHERE id = ANY($2::uuid[]) AND holding_id = $3 AND status = '${PENDING_STATUS}'`,
			[consolidatedId, plan.invoices.map((invoice) => invoice.id), holdingId]
		);
		// Moneda de sistema con la regla por estado (04-10): el consolidado nace Por Emitir → desde la moneda de contrato del encabezado. En
		// modo `mixed` no hay una sola moneda de contrato y el encabezado queda en moneda de factura (`amount_contract_currency` = neto en
		// esa moneda): se convierte ese monto, igual que lo haría el trigger o cualquier edición posterior. Al emitir pasa a la moneda de
		// factura (mismo monto en `mixed`).
		await refreshInvoiceSystemAmounts(runner, holdingId, [consolidatedId]);

		return consolidatedId;
	}

	/**
	 * Copias de las líneas de los orígenes en el consolidado (glosa con el número de contrato al final, `contract_id`, montos y tasa de la
	 * valorización del plan). `kept` (re-copia): glosas escritas a mano en la unificada que se conservan, por línea de origen.
	 */
	private async insertCopies(
		runner: QueryRunner,
		consolidatedId: string,
		plan: ConsolidationPlan,
		invoiceCurrency: string | null,
		issueDate: string | null,
		holdingId: string,
		kept: Map<string, string> = new Map()
	): Promise<void> {
		await runner.query(
			`INSERT INTO invoice_items (
				invoice_id, holding_id, contract_item_id, contract_id, product_id, description, description_locked, quantity, unit_of_measure,
				discount_pct, tax_code, odoo_tax_id, custom_fields, subscription_item_id, pricing_breakdown, quantity_source,
				unit_price_contract_currency, subtotal_contract_currency, tax_amount_contract_currency, total_contract_currency,
				unit_price_invoice_currency, subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
				contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date,
				billing_period_start, billing_period_end, status, issue_date
			) SELECT
				$1::uuid, s.holding_id, s.contract_item_id, p.contract_id, s.product_id, p.description, COALESCE(p.locked, s.description_locked), s.quantity, s.unit_of_measure,
				s.discount_pct, s.tax_code, s.odoo_tax_id, s.custom_fields, s.subscription_item_id, s.pricing_breakdown, s.quantity_source,
				s.unit_price_contract_currency, s.subtotal_contract_currency, s.tax_amount_contract_currency, s.total_contract_currency,
				p.unit_price_invoice, p.subtotal_invoice, p.tax_invoice, p.total_invoice,
				p.currency, $3, p.fx, p.fx_rate_source, p.fx_rate_date,
				s.billing_period_start, s.billing_period_end, '${PENDING_STATUS}', $4::date
			FROM jsonb_to_recordset($2::jsonb) AS p(
				source_id uuid, ord int, contract_id uuid, description text, locked boolean, currency text, fx numeric, fx_rate_source text, fx_rate_date date,
				unit_price_invoice numeric, subtotal_invoice numeric, tax_invoice numeric, total_invoice numeric
			)
			JOIN invoice_items s ON s.id = p.source_id AND s.holding_id = $5
			ORDER BY p.ord`,
			[
				consolidatedId,
				JSON.stringify(
					plan.lines.map((line, index) => ({
						source_id: line.source_line_id,
						ord: index,
						contract_id: line.contract_id,
						description: kept.get(line.source_line_id) ?? line.description,
						locked: kept.has(line.source_line_id) ? true : null,
						currency: line.currency,
						fx: line.fx,
						fx_rate_source: line.fx_rate_source,
						fx_rate_date: line.fx_rate_date,
						unit_price_invoice: line.unit_price_invoice_currency,
						subtotal_invoice: line.subtotal_invoice_currency,
						tax_invoice: line.tax_invoice_currency,
						total_invoice: line.total_invoice_currency,
					}))
				),
				invoiceCurrency,
				issueDate,
				holdingId,
			]
		);
	}

	/**
	 * Consumo sobre un período consolidado (Domi 05-10): el consumo recalculó la factura de ORIGEN (inactiva) de un unificado v2 Por Emitir;
	 * aquí se vuelven a copiar las líneas de TODOS sus orígenes al unificado (los unificados no se editan: sus líneas son siempre copias) y su
	 * encabezado se recalcula con las mismas reglas que al consolidar (`planConsolidation`, ignorando los bloqueos de elegibilidad, que ya se
	 * pasaron al consolidar). Conserva identidad, contrato principal, fechas y referencias del unificado; moneda de sistema con
	 * `refreshInvoiceSystemAmounts`. Las glosas escritas a mano en la unificada (`description_locked`, Editar descripción) se conservan
	 * (`keptUnifiedDescriptions`). Corre dentro de la transacción del llamador (costura y locks ya tomados). Devuelve el encabezado nuevo.
	 */
	async resyncFromOrigins(runner: QueryRunner, holdingId: string, consolidatedId: string) {
		const [unified] = (await runner.query(
			`SELECT id, invoice_number, status, contract_id, invoice_currency, issue_date::text AS issue_date FROM invoices
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}' AND is_active = true FOR UPDATE`,
			[consolidatedId, holdingId]
		)) as Row[];

		if (!unified)
			throw new ConflictException({ message: 'El documento unificado ya no está Por Emitir: no se puede recalcular', code: 'not_pending' });
		const origins = await this.loadOrigins(runner, holdingId, consolidatedId);

		if (!origins.length) throw new ConflictException({ message: 'El documento unificado no tiene facturas de origen', code: 'no_origins' });
		const ctx = await this.loadContext(
			runner,
			holdingId,
			origins.map((origin) => origin.id)
		);
		// El principal es el de la unificada (orden de las líneas y límite de la glosa iguales a los de la primera copia).
		const plan = planConsolidation({ ...ctx, main_contract_id: toText(unified.contract_id) });
		const header = plan.header;
		const unifiedLocked = (await runner.query(
			`SELECT ${COPY_KEY_SQL}, ii.description FROM invoice_items ii WHERE ii.invoice_id = $1 AND ii.holding_id = $2 AND ii.description_locked = true`,
			[consolidatedId, holdingId]
		)) as Row[];
		const kept = await this.keptDescriptions(
			runner,
			holdingId,
			unifiedLocked.map((row) => ({ ...this.copyKeyOf(row), description: toText(row.description) })),
			plan
		);

		await runner.query(`DELETE FROM invoice_items WHERE invoice_id = $1 AND holding_id = $2`, [consolidatedId, holdingId]);
		await this.insertCopies(runner, consolidatedId, plan, toText(unified.invoice_currency), toText(unified.issue_date), holdingId, kept);
		await runner.query(
			`UPDATE invoices SET vat = $3, amount_contract_currency = $4, amount_invoice_currency = $5, total_invoice_currency = $6,
				contract_currency = $7, fx_contract_to_invoice = $8
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
			[
				consolidatedId,
				holdingId,
				header.vat,
				header.amount_contract_currency,
				header.amount_invoice_currency,
				header.total_invoice_currency,
				header.contract_currency,
				header.fx_contract_to_invoice,
			]
		);
		await refreshInvoiceSystemAmounts(runner, holdingId, [consolidatedId]);

		return {
			invoice_id: consolidatedId,
			invoice_number: toText(unified.invoice_number),
			amount_contract_currency: header.amount_contract_currency,
			vat: header.vat,
			amount_invoice_currency: header.amount_invoice_currency,
			total_invoice_currency: header.total_invoice_currency,
			lines_count: plan.lines.length,
			kept_descriptions: kept.size,
		};
	}

	/**
	 * Glosas protegidas de una unificada (`description_locked`) que la copia nueva conserva, por línea de origen (`keptUnifiedDescriptions`:
	 * ítem, período y fila de tramo). La usan la re-copia por consumo (`resyncFromOrigins`) y re-unificar por la regla (`reunifyInvoices`).
	 */
	private async keptDescriptions(
		db: Queryable,
		holdingId: string,
		locked: Array<CopyLineKey & { description: string | null }>,
		plan: ConsolidationPlan
	): Promise<Map<string, string>> {
		if (!locked.length || !plan.lines.length) return new Map();
		const sourceTiers = (await db.query(
			`SELECT ii.id, ${COPY_KEY_SQL} FROM invoice_items ii WHERE ii.id = ANY($1::uuid[]) AND ii.holding_id = $2`,
			[plan.lines.map((line) => line.source_line_id), holdingId]
		)) as Row[];
		const tierOf = new Map(sourceTiers.map((row) => [String(row.id), toText(row.tier_index)]));

		return keptUnifiedDescriptions(
			locked,
			plan.lines.map((line) => ({
				source_line_id: line.source_line_id,
				contract_id: line.contract_id,
				contract_item_id: line.contract_item_id,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
				tier_index: tierOf.get(line.source_line_id) ?? null,
				description: line.description,
			}))
		);
	}

	private referenceOf(row: Row): ConsolidationReference {
		return {
			id: String(row.id),
			source: row.source === 'contract' ? 'contract' : 'invoice',
			invoice_id: String(row.invoice_id),
			type: toText(row.type) ?? '',
			name: toText(row.name),
			code: toText(row.code) ?? '',
		};
	}

	private copyKeyOf(row: Row) {
		return {
			contract_id: toText(row.contract_id),
			contract_item_id: toText(row.contract_item_id),
			billing_period_start: toText(row.billing_period_start),
			billing_period_end: toText(row.billing_period_end),
			tier_index: toText(row.tier_index),
		};
	}

	private async insertEvent(
		runner: QueryRunner,
		holdingId: string,
		userId: string | null,
		contractId: string,
		type: string,
		effectiveDate: string,
		event: { title: string; description: string; metadata: Record<string, unknown> }
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb) RETURNING id`,
			[
				contractId,
				holdingId,
				type,
				event.title,
				event.description,
				userId,
				effectiveDate,
				JSON.stringify({ source: 'contract_360', ...event.metadata }),
			]
		)) as Row[];

		return String(row.id);
	}

	// ---------------------------------------------------------------- carga

	async loadContext(db: Queryable, holdingId: string, invoiceIds: string[]): Promise<ConsolidationContext> {
		const ids = [...new Set(invoiceIds)];
		const invoices = await this.loadInvoices(db, holdingId, ids);
		const contractIds = [...new Set(invoices.map((invoice) => invoice.contract_id).filter((id): id is string => !!id))];
		const [lines, references, limits] = await Promise.all([
			db.query(LINES_SQL, [ids, holdingId]) as Promise<Row[]>,
			db.query(REFERENCES_SQL, [ids, holdingId]) as Promise<Row[]>,
			contractIds.length ? (db.query(LIMITS_SQL, [contractIds, holdingId]) as Promise<Row[]>) : Promise.resolve([] as Row[]),
		]);

		return {
			invoices,
			lines: lines.map((row) => this.lineOf(row)),
			references: references.map((row) => this.referenceOf(row)),
			max_chars_by_contract: new Map(limits.map((row) => [String(row.id), descriptionMaxCharsOfRow(row)])),
		};
	}

	/** Facturas del holding por id, en el orden pedido (404 si alguna no existe o es de otro holding). */
	async loadInvoices(db: Queryable, holdingId: string, ids: string[]): Promise<ConsolidationInvoice[]> {
		const unique = [...new Set(ids)];
		const rows = (await db.query(`${INVOICE_SQL} WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[])`, [holdingId, unique])) as Row[];
		const byId = new Map(rows.map((row) => [String(row.id), this.invoiceOf(row)]));
		const missing = unique.filter((id) => !byId.has(id));

		if (missing.length) throw new NotFoundException(`Facturas no encontradas: ${missing.join(', ')}`);

		return unique.map((id) => byId.get(id)!);
	}

	private async loadOrigins(db: Queryable, holdingId: string, consolidatedId: string): Promise<ConsolidationInvoice[]> {
		const rows = (await db.query(
			`${INVOICE_SQL} WHERE i.holding_id = $1 AND i.consolidated_into_invoice_id = $2::uuid ORDER BY i.issue_date, i.id`,
			[holdingId, consolidatedId]
		)) as Row[];

		return rows.map((row) => this.invoiceOf(row));
	}

	private async contractIdsOf(db: Queryable, holdingId: string, ids: string[]): Promise<string[]> {
		const rows = (await db.query(
			`SELECT DISTINCT i.contract_id FROM invoices i WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[]) AND i.contract_id IS NOT NULL`,
			[holdingId, [...new Set(ids)]]
		)) as Row[];

		return rows.map((row) => String(row.contract_id));
	}

	private async lockInvoices(runner: QueryRunner, holdingId: string, ids: string[]): Promise<void> {
		await runner.query(`SELECT id FROM invoices WHERE holding_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [
			holdingId,
			[...new Set(ids)],
		]);
	}

	private invoiceOf(row: Row): ConsolidationInvoice {
		return {
			id: String(row.id),
			invoice_number: toText(row.invoice_number),
			contract_id: toText(row.contract_id),
			contract_number: toText(row.contract_number),
			client_id: toText(row.client_id),
			client_name: toText(row.client_name),
			status: toText(row.status),
			document_type: toText(row.document_type),
			invoice_type: toText(row.invoice_type),
			is_active: row.is_active !== false,
			is_legacy: row.is_legacy === true,
			consolidated_into_invoice_id: toText(row.consolidated_into_invoice_id),
			company_id: toText(row.company_id),
			client_entity_id: toText(row.client_entity_id),
			legal_name: toText(row.legal_name),
			invoice_currency: toText(row.invoice_currency),
			contract_currency: toText(row.contract_currency),
			issue_date: toText(row.issue_date),
			scheduled_at: toText(row.scheduled_at),
			due_date: toText(row.due_date),
			export_type: toNumber(row.export_type),
			invoice_series: toText(row.invoice_series),
			tax_rate: toNullableNumber(row.tax_rate),
			amount_contract_currency: toNullableNumber(row.amount_contract_currency),
			vat: toNullableNumber(row.vat),
			amount_invoice_currency: toNullableNumber(row.amount_invoice_currency),
			total_invoice_currency: toNullableNumber(row.total_invoice_currency),
			amount_system_currency: toNullableNumber(row.amount_system_currency),
			total_system_currency: toNullableNumber(row.total_system_currency),
			odoo_invoice_id: toNullableNumber(row.odoo_invoice_id),
			sent_to_odoo_at: toIso(row.sent_to_odoo_at),
			auto_invoice: row.auto_invoice === true,
			requires_references: row.requires_references_for_billing === true,
			contract_requires_references: row.contract_requires_references === true,
			contract_auto_send_to_erp: row.auto_send_to_odoo !== false,
			lines_count: toNumber(row.lines_count),
			internal_lines: toNumber(row.internal_lines),
			open_lines: toNumber(row.open_lines),
			cutoff_date: toText(row.cutoff_date),
		};
	}

	private lineOf(row: Row): ConsolidationLine {
		return {
			id: String(row.id),
			invoice_id: String(row.invoice_id),
			contract_id: toText(row.contract_id),
			contract_item_id: toText(row.contract_item_id),
			description: toText(row.description) ?? '',
			product_name: toText(row.product_name),
			currency: toText(row.contract_currency),
			quantity: toNumber(row.quantity),
			unit_price: toNumber(row.unit_price_contract_currency),
			subtotal: toNumber(row.subtotal_contract_currency),
			tax: toNumber(row.tax_amount_contract_currency),
			total: toNumber(row.total_contract_currency),
			unit_price_invoice: toNullableNumber(row.unit_price_invoice_currency),
			subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
			tax_invoice: toNullableNumber(row.tax_amount_invoice_currency),
			total_invoice: toNullableNumber(row.total_invoice_currency),
			fx: toNullableNumber(row.fx_contract_to_invoice),
			fx_rate_source: toText(row.fx_rate_source),
			fx_rate_date: toText(row.fx_rate_date),
			billing_period_start: toText(row.billing_period_start),
			billing_period_end: toText(row.billing_period_end),
		};
	}

	// ---------------------------------------------------------------- transacción y errores

	/** Una transacción con la costura `sapira.writer = 'api'` primero y los contratos involucrados bloqueados (`FOR UPDATE`, orden por id). */
	private async transaction<T>(contractIds: string[], holdingId: string, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();
		let active = false;

		await runner.connect();
		await runner.startTransaction();
		active = true;
		try {
			await setApiWriter(runner);
			await runner.query(
				`SELECT id FROM contracts WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
				[[...contractIds].sort(), holdingId]
			);
			const result = await work(runner);

			await runner.commitTransaction();
			active = false;

			return result;
		} catch (error) {
			if (active) await runner.rollbackTransaction();
			if (!(error instanceof HttpException))
				this.logger.warn(`Consolidación de facturas no aplicada: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		} finally {
			await runner.release();
		}
	}

	private blocked(blockers: InvoiceBlocker[], preview: unknown): ConflictException {
		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			preview,
		});
	}
}

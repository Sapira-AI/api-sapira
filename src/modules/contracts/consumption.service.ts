import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';
import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { invoiceTermsSql, refreshInvoiceSystemAmounts } from './api-written-fields';
import { computeDueDate, descriptionFittedWarning, lineDescription, normalizeTaxRate, round2 } from './billing-engine';
import { todayFor } from './business-date';
import {
	additionalDifference,
	type AdditionalDifference,
	additionalPricedLine,
	type ApplyAsMode,
	classifyPeriodLines,
	type ConsumptionPeriodLine,
	discountPctFor,
	fixedItemConflict,
	headerAmounts,
	invoicedReferenceName,
	isPendingLine,
	issuedConflict,
	type IssuedOutcome,
	issuedOutcome,
	type LineAmounts,
	lineAmounts,
	noAdditionalConflict,
	notMeteredConflict,
	type OnIssuedMode,
	onIssuedOf,
	outOfItemConflict,
	priceStandardLine,
	resolveApplyAs,
	UNIFIED_INVOICE_TYPE,
} from './consumption';
import {
	buildConsumption,
	CANCELLED_STATUS,
	consolidatedPendingSql,
	type ConsumptionEntryRow,
	type ConsumptionInvoiceLine,
	type ConsumptionItem,
	noChargeSql,
	PENDING_STATUS,
	unifiedV2Sql,
	voidedSql,
} from './contract-360';
import { ERP_DRAFT_STALE_MESSAGE } from './contract-changes';
import { insertMirrorCreditNote } from './contract-changes.service';
import { cleanPaymentTerms, resolveUserId } from './contract-drafts.service';
import { ContractInvoiceConsolidationService } from './contract-invoice-consolidation.service';
import { INVOICE_EVENT_TYPES } from './contract-invoices';
import { SYSTEM_ACTOR_ID } from './contract-renewals';
import { ContractsService } from './contracts.service';
import {
	DEFAULT_TEMPLATE,
	DESCRIPTION_FITTED_CODE,
	type DescriptionBlock,
	type DescriptionContext,
	type DescriptionTemplate,
	exceedsMax,
	fitDescription,
} from './invoice-description';
import { MANUAL_EDIT_KEPT, MANUAL_QUANTITY_SOURCE } from './invoice-edit';
import { multicurrencyHeader } from './multicurrency';
import { revalueMulticurrencyInvoices } from './multicurrency-invoices';
import { PRICE_COLUMNS, priceSpecFromRow, priceSummaryFromRow } from './price-rows';
import {
	asciiGlosa,
	baseGlosa,
	describeSingleLine,
	distributeTax,
	isMetered,
	type PricedLine,
	type PricedSubline,
	priceLine,
	type PriceLineOptions,
	type PriceSpec,
	splitInvoiceLines,
} from './pricing-engine';
import { DESCRIPTION_LIMITS_SQL, descriptionMaxCharsOfRow } from './tax-document-types';

import type { ConsumptionBulkDto, QueryConsumptionPendingDto, UpsertConsumptionDto } from './dtos/consumption.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const isoDay = (value: unknown) => iso(value)?.slice(0, 10) ?? null;
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
const DEFAULT_LIMIT = 25;
/** Revisiones por entry que devuelve `GET /contracts/:id/consumption` (más nuevas primero). */
export const MAX_REVISIONS = 20;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Línea del período con la fecha de envío al ERP (borrador): `odoo_invoice_id` o `sent_to_odoo_at` = borrador vigente. */
type PeriodLine = ConsumptionPeriodLine & { sent_to_odoo_at?: string | null };
const hasErpDraft = (line: PeriodLine) => (line.odoo_invoice_id !== null && line.odoo_invoice_id !== undefined) || Boolean(line.sent_to_odoo_at);
export const ERP_DRAFT_STALE_CODE = 'erp_draft_stale';
/** Aviso: el consumo recalculó también el documento unificado Por Emitir que lleva la factura de origen del período. */
export const CONSOLIDATED_RESYNC_CODE = 'consolidated_resynced';
/** Origen de una escritura de consumo (`consumption_entries.source`): pantalla, CSV o sincronización del almacén de datos. */
export type ConsumptionWriteSource = 'manual' | 'csv' | 'dwh';

/** Consumo vigente tal como lo compara la sincronización del almacén de datos. */
export interface DwhEntryView {
	id: string;
	contract_id: string;
	contract_item_id: string;
	period_start: string;
	quantity: number;
	/** Unitario efectivo: monto fijado ÷ cantidad, o el del ítem. */
	unit_price: number | null;
	unit_of_measure: string | null;
	account: string | null;
}

const dwhEntryView = (row: Row): DwhEntryView => {
	const quantity = toNumber(row.quantity);
	const override = toNullableNumber(row.amount_override);

	return {
		id: String(row.id),
		contract_id: String(row.contract_id),
		contract_item_id: String(row.contract_item_id),
		period_start: String(row.period_start).slice(0, 10),
		quantity,
		unit_price: override !== null && quantity > 0 ? Math.round((override / quantity) * 1e6) / 1e6 : toNullableNumber(row.unit_price),
		unit_of_measure: toText(row.unit_of_measure),
		account: toText(row.account),
	};
};

/**
 * Monto fijado de un consumo informado con unitario (DWH, override del front anterior): unitario × cantidad cuando el unitario difiere del
 * del ítem; null (cantidad × precio del ítem) si es el mismo o no viene. Misma regla que la migración `1791600000000`.
 */
export const dwhAmountOverride = (quantity: number, unitPrice: number | null, itemUnitPrice: number | null): number | null =>
	unitPrice === null || unitPrice === undefined || (itemUnitPrice !== null && Math.abs(Number(unitPrice) - Number(itemUnitPrice)) < 1e-9)
		? null
		: round2(Number(unitPrice) * Number(quantity));

/** Fila de respuesta sin los montos internos (`amounts`) que solo usa la escritura. */
const stripAmounts = (part: ConsumptionLineRow & { amounts: LineAmounts }): ConsumptionLineRow => {
	const copy: Partial<ConsumptionLineRow & { amounts: LineAmounts }> = { ...part };

	delete copy.amounts;

	return copy as ConsumptionLineRow;
};
/** Cuántas glosas generadas por una operación de consumo se ajustaron al límite del documento. */
interface FitCounter {
	count: number;
}

/** Bloques producto + cuenta + período de la glosa de hoy (`DEFAULT_TEMPLATE` sin el tramo). */
const BASE_BLOCKS: DescriptionBlock[] = DEFAULT_TEMPLATE.blocks.filter((block) => block.type !== 'tier');

/**
 * Glosa que genera el consumo, ajustada al límite del documento en el origen (decisión 30-09): si la de hoy (`legacy`) cabe, va tal cual;
 * si no, se renderiza con la plantilla equivalente y `fitDescription` la acorta (período corto, sin etiquetas, sin cuenta, …).
 */
export function fitConsumptionGlosa(
	legacy: string,
	template: DescriptionTemplate,
	context: DescriptionContext,
	maxChars: number | null,
	counter?: FitCounter
): string {
	if (!exceedsMax(legacy.length, maxChars)) return legacy;
	if (counter) counter.count++;

	return fitDescription(template, context, maxChars).text;
}

/** Agrega el aviso `description_fitted` (una vez) a los avisos de una operación de consumo. */
const addFittedWarning = (warnings: string[], codes: string[], count: number, maxChars: number | null) => {
	if (!count) return;
	const message = descriptionFittedWarning(count, maxChars);

	if (!warnings.includes(message)) warnings.push(message);
	if (!codes.includes(DESCRIPTION_FITTED_CODE)) codes.push(DESCRIPTION_FITTED_CODE);
};

/** Origen de las líneas que crea el consumo (complementaria y reemisión). */
export const CONSUMPTION_FX_RATE_SOURCE = 'consumption';

/** Ítem del contrato que recibe cantidad: medido (con su precio y métrica) o estándar (`is_metered = false`, unitario del ítem). */
interface MeteredItem {
	id: string;
	contract_id: string;
	product_name: string | null;
	account: string | null;
	quantity: number;
	/** `contract_items.unit_price` (mensual): respaldo del unitario del período cuando la línea no lo trae. */
	unit_price: number;
	/** `false` = ítem estándar sin modelo de precio: cantidad × unitario del período de la línea. */
	is_metered: boolean;
	unit_of_measure: string | null;
	discount_type: string | null;
	discount_value: number | null;
	price: PriceSpec | null;
	price_summary: ReturnType<typeof priceSummaryFromRow>;
	metric: { id: string; code: string; name: string; unit: string; aggregation: string } | null;
	/** Límite de caracteres de la descripción del documento del contrato (null = sin límite): las glosas generadas se ajustan a él. */
	description_max_chars: number | null;
}

/** Entry vigente tal como se devuelve. */
interface EntryView {
	id: string;
	contract_item_id: string;
	period_start: string;
	period_end: string;
	quantity: number;
	amount_override: number | null;
	apply_item_discount: boolean;
	account: string | null;
	is_estimated: boolean;
	source: string;
	revision: number;
	correction_reason: string | null;
	notes: string | null;
	idempotency_key: string | null;
	/** Factura que lleva el consumo (Por Emitir recalculada, complementaria o reemitida); null si solo había anuladas. */
	invoice_id: string | null;
	created_at: string | null;
	updated_at: string | null;
}

export type ConsumptionEvent = 'CONSUMPTION_RECORDED' | 'CONSUMPTION_CORRECTED' | 'CONSUMPTION_ADDITIONAL_INVOICE' | 'CONSUMPTION_REISSUE';
/** Qué se hizo con la factura del período. */
export type ConsumptionWriteMode = 'recompute' | 'none' | 'additional' | 'reissue';

/** Fila de `invoice_items` escrita (o que se escribiría) para el ítem y período. */
export interface ConsumptionLineRow {
	/** null en la vista previa de filas nuevas (`per_tier`, complementaria, reemisión). */
	id: string | null;
	description: string;
	quantity: number;
	unit_price: number;
	subtotal: number;
	tax_amount: number;
	total: number;
	quantity_source: string;
	pricing_breakdown: PricedSubline[];
	/** Glosa escrita a mano que se conserva al recomponer (spec facturas §3.6); ausente = false. */
	description_locked?: boolean;
	/** Solo `per_tier`. */
	part?: { part: 'charge' | 'adjustment'; index: number; count: number };
}

export interface ConsumptionInvoiceView {
	id: string;
	invoice_number: string | null;
	status: string | null;
	issue_date: string | null;
	currency: string | null;
	fx: number | null;
	subtotal: number;
	tax: number;
	total: number;
}

export interface ConsumptionWriteResult extends IssuedOutcomeView {
	entry: EntryView;
	/** Línea lógica del ítem y período (cantidad, unitario efectivo, subtotal y desglose completo); null si el período solo tiene facturas anuladas. */
	line: (PricedLine & { id: string | null; invoice_id: string | null; tax_amount: number; total: number }) | null;
	/** Filas de factura de esa línea: una en `single`, varias en `per_tier`; la única de la complementaria. */
	lines: ConsumptionLineRow[];
	/** Factura que lleva el consumo: la Por Emitir recalculada, la complementaria o la reemitida. */
	invoice: ConsumptionInvoiceView | null;
	event: ConsumptionEvent;
	mode: ConsumptionWriteMode;
	/** Cómo se pidió aplicar la cantidad (eco del body; `recompute` si no venía). */
	apply_as: ApplyAsMode;
	/** Alias histórico de `apply_as` (`block` = `recompute`). */
	on_issued: OnIssuedMode;
	/** `additional`: factura a la que complementa la nueva (la emitida, o la Por Emitir del período). */
	complements_invoice: { id: string; invoice_number: string | null; status: string | null; issue_date: string | null } | null;
	warnings: string[];
	/** Códigos estables de avisos que la UI distingue (hoy: `manual_edit_kept`, la línea editada a mano no se recalculó). */
	warning_codes: string[];
	/** `true` si la clave de idempotencia ya estaba registrada: no se escribió nada. */
	idempotent: boolean;
	/** `reissue`: NC espejo creada (estado de la emitida, nunca Por Emitir; montos negativos). */
	credit_note: { id: string | null; number: string | null; total: number } | null;
	/** `reissue`: la emitida que la NC anula (nunca se modifica). */
	cancelled_invoice: { id: string; invoice_number: string | null } | null;
	/** Lo creado en la transacción (vacío en el recálculo de una Por Emitir existente). */
	created: { invoice_id?: string; credit_note_id?: string; invoice_number?: string };
}

/** Emitida del período y si la complementaria es posible (§4.4); todo null/false cuando el período no tiene emitida. */
interface IssuedOutcomeView {
	issued_invoice: IssuedOutcome['issued_invoice'] | null;
	additional_amount: number | null;
	additional_allowed: boolean;
	additional_reason: string | null;
}
const NO_ISSUED: IssuedOutcomeView = { issued_invoice: null, additional_amount: null, additional_allowed: false, additional_reason: null };

/** Encabezado de una factura emitida, con lo que hace falta del contrato para clonarla (§4.4). */
interface IssuedInvoiceHeader {
	id: string;
	invoice_number: string | null;
	status: string | null;
	issue_date: string | null;
	due_date: string | null;
	company_id: string | null;
	client_id: string | null;
	client_entity_id: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	system_currency: string | null;
	fx: number | null;
	tax_rate: number;
	document_type: string | null;
	export_type: number | null;
	issuer_tax_id: string | null;
	issuer_legal_name: string | null;
	issuer_address: string | null;
	client_tax_id: string | null;
	payment_method: string | null;
	fiscal_regime: string | null;
	invoice_series: string | null;
	requires_references_for_billing: boolean;
	auto_invoice: boolean;
	invoice_terms_and_conditions: string | null;
	contract_document_type: string | null;
	fx_invoice_policy: string | null;
	payment_terms: unknown;
	entity_payment_terms: unknown;
	company_country: string | null;
	/** Multimoneda: `contracts.requires_multicurrency_billing` (cada línea de la factura nueva se valoriza con su par). */
	multicurrency?: boolean;
}

/** Línea de una factura emitida tal como se lee para reemitirla (misma forma que `ChangeInvoiceLineRow`). */
interface IssuedLineRow {
	id: string;
	invoice_id: string;
	contract_item_id: string | null;
	product_id: string | null;
	description: string | null;
	quantity: number;
	unit_price: number;
	unit_price_invoice: number | null;
	discount_pct: number;
	subtotal: number;
	subtotal_invoice: number | null;
	tax_amount: number;
	tax_amount_invoice: number | null;
	total: number;
	total_invoice: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	unit_of_measure: string | null;
	quantity_source: string | null;
	pricing_breakdown: PricedSubline[] | null;
	/** Glosa escrita a mano: la reemisión la copia y la conserva bloqueada. */
	description_locked?: boolean;
}

/** Fila a insertar en `invoice_items` (con su `contract_item_id` en el mismo INSERT). */
interface NewLine {
	contract_item_id: string | null;
	product_id: string | null;
	description: string;
	quantity: number;
	unit_of_measure: string | null;
	discount_pct: number;
	amounts: LineAmounts;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity_source: string | null;
	pricing_breakdown: PricedSubline[] | null;
	description_locked?: boolean;
}

interface WritePlan {
	entry: Omit<EntryView, 'id'>;
	event: ConsumptionEvent;
	mode: ConsumptionWriteMode;
	warnings: string[];
	warning_codes: string[];
	/** Sin cobro: `becomes` = la Por Emitir queda toda en 0 y pasa a Cancelada; `reverted` = una sin cobro recupera cantidad. */
	no_charge: 'becomes' | 'reverted' | null;
	/** Línea lógica tarifada con el consumo nuevo (null en `none`). */
	priced: PricedLine | null;
	/** `recompute`: factura Por Emitir y sus filas actuales del ítem/período; filas nuevas a escribir. */
	target: ConsumptionPeriodLine | null;
	target_lines: ConsumptionPeriodLine[];
	parts: Array<ConsumptionLineRow & { amounts: LineAmounts }>;
	/** `additional` / `reissue` (o recálculo de una complementaria): la emitida y sus filas del ítem/período. */
	issued: ConsumptionPeriodLine | null;
	issued_lines: ConsumptionPeriodLine[];
	/** `additional`: factura a la que complementa la nueva (la emitida, o la Por Emitir del período) y sus filas del ítem. */
	reference: ConsumptionPeriodLine | null;
	reference_lines: ConsumptionPeriodLine[];
	additional: AdditionalDifference | null;
	outcome: IssuedOutcomeView;
	apply_as: ApplyAsMode;
	/** Vista de respuesta antes de escribir (el encabezado definitivo se relee o se calcula al escribir). */
	line: ConsumptionWriteResult['line'];
	invoice: ConsumptionInvoiceView | null;
}

/**
 * Consumos de Contratos v2 (Pricing v2 etapa 2, `docs/v2-rediseno/spec-pricing-v2.md` §4.3 y §5): registrar y corregir el
 * consumo de un ítem medido por período, con recálculo de la factura Por Emitir del período en la misma transacción,
 * vista previa sin escribir, importación masiva y "pendientes de informar". Los ítems estándar (sin modelo de precio) también
 * reciben cantidad mientras la factura del período esté Por Emitir (cantidad × unitario del período). Nunca toca facturas
 * emitidas, anuladas, NC/ND, unificadas, legacy ni líneas de otros ítems. Todo acotado al holding del guard.
 */
@Injectable()
export class ConsumptionService {
	private readonly logger = new Logger(ConsumptionService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly consolidation: ContractInvoiceConsolidationService
	) {}

	// ---------------------------------------------------------------- lectura: GET /contracts/:id/consumption

	/**
	 * Consumos del contrato: `consumption_entries` (única fuente desde el 05-10: los overrides del front anterior se copiaron desde
	 * `quantities` con la migración `1791600000000` y se muestran igual que cualquier consumo o corrección), todos los ítems con su precio y
	 * métrica, los períodos facturables de cada ítem y los pendientes de informar.
	 */
	async list(idOrNumber: string, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const [entryRows, revisionRows, itemRows, lineRows] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT e.id, e.contract_item_id, e.period_start::text AS period_start, e.period_end::text AS period_end, e.quantity, e.amount_override,
					e.apply_item_discount, e.account, e.is_estimated, e.source, e.revision, e.correction_reason, e.notes, e.idempotency_key, e.invoice_id,
					e.created_at, e.updated_at, u.id AS recorded_by_id, COALESCE(u.name, u.email) AS recorded_by_name,
					(SELECT COUNT(*) FROM consumption_entry_revisions r WHERE r.entry_id = e.id) AS revisions_count
				FROM consumption_entries e
				LEFT JOIN users u ON u.id = COALESCE(e.updated_by, e.created_by)
				WHERE e.contract_id = $1 AND e.holding_id = $2
				ORDER BY e.period_start DESC, e.contract_item_id`,
				[contract.id, holdingId]
			),
			// Historial por entry (más nuevo primero, máximo 20 por entry) con quién lo registró.
			this.dataSource.query<Row[]>(
				`SELECT r.entry_id, r.revision, r.quantity, r.amount_override, r.reason, r.changed_at,
					u.id AS recorded_by_id, COALESCE(u.name, u.email) AS recorded_by_name
				FROM consumption_entry_revisions r
				JOIN consumption_entries e ON e.id = r.entry_id
				LEFT JOIN users u ON u.id = r.changed_by
				WHERE e.contract_id = $1 AND e.holding_id = $2
				ORDER BY r.entry_id, r.revision DESC`,
				[contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ci.id, ci.product_name, ci.account, ci.quantity, ci.unit_of_measure, ${PRICE_COLUMNS},
					bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit, bm.aggregation AS metric_aggregation
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				LEFT JOIN prices p ON p.id = ci.price_id
				LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id
				WHERE ci.contract_id = $1 AND c.holding_id = $2
				ORDER BY ci.product_name, ci.account NULLS FIRST, ci.start_date NULLS FIRST, ci.id`,
				[contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ii.id AS line_id, ii.contract_item_id, ii.billing_period_start::text AS billing_period_start,
					ii.billing_period_end::text AS billing_period_end, ii.quantity, ii.quantity_source, ii.subtotal_contract_currency, ii.pricing_breakdown,
					i.id AS invoice_id, i.invoice_number, i.status, i.is_active, i.issue_date::text AS issue_date, i.document_type, i.invoice_type,
					COALESCE(i.is_legacy, false) AS is_legacy, ${consolidatedPendingSql('i')} AS consolidated_pending,
					(i.invoice_type = '${UNIFIED_INVOICE_TYPE}' AND ${unifiedV2Sql('i')}) AS unified_v2,
					i.credit_type, ${noChargeSql('i')} AS no_charge, ${voidedSql('i')} AS voided
				FROM invoice_items ii
				JOIN invoices i ON i.id = ii.invoice_id
				-- Por el contrato del ÍTEM (no el del encabezado): un unificado lleva el contrato principal y líneas de los demás.
				JOIN contract_items lci ON lci.id = ii.contract_item_id
				WHERE lci.contract_id = $1 AND i.holding_id = $2
				ORDER BY ii.billing_period_start, i.issue_date DESC NULLS LAST, i.id`,
				[contract.id, holdingId]
			),
		]);
		const recordedBy = (row: Row) => (row.recorded_by_id ? { id: String(row.recorded_by_id), name: toText(row.recorded_by_name) } : null);
		const revisionsByEntry = new Map<string, ConsumptionEntryRow['revisions']>();

		for (const row of revisionRows) {
			const list = revisionsByEntry.get(String(row.entry_id)) ?? [];

			if (list.length >= MAX_REVISIONS) continue;
			list.push({
				revision: toNumber(row.revision),
				quantity: toNumber(row.quantity),
				amount_override: toNullableNumber(row.amount_override),
				correction_reason: toText(row.reason),
				recorded_by: recordedBy(row),
				recorded_at: iso(row.changed_at),
			});
			revisionsByEntry.set(String(row.entry_id), list);
		}
		const entries: ConsumptionEntryRow[] = entryRows.map((row) => ({
			...this.entryView(row),
			revisions_count: toNumber(row.revisions_count),
			recorded_by: recordedBy(row),
			recorded_at: iso(row.updated_at),
			revisions: revisionsByEntry.get(String(row.id)) ?? [],
		}));
		const items: ConsumptionItem[] = itemRows.map((row) => ({
			id: String(row.id),
			product_name: toText(row.product_name),
			account: toText(row.account) || null,
			quantity: toNullableNumber(row.quantity),
			unit_of_measure: toText(row.unit_of_measure),
			price: priceSummaryFromRow(row),
			metric: row.metric_id
				? {
						id: String(row.metric_id),
						code: toText(row.metric_code) ?? '',
						name: toText(row.metric_name) ?? '',
						unit: toText(row.metric_unit) ?? '',
						aggregation: toText(row.metric_aggregation) ?? '',
					}
				: null,
		}));
		const lines: ConsumptionInvoiceLine[] = lineRows.map((row) => ({
			line_id: String(row.line_id),
			contract_item_id: String(row.contract_item_id),
			billing_period_start: toText(row.billing_period_start),
			billing_period_end: toText(row.billing_period_end),
			quantity: toNullableNumber(row.quantity),
			quantity_source: toText(row.quantity_source),
			subtotal: toNullableNumber(row.subtotal_contract_currency),
			pricing_breakdown: (parseJson(row.pricing_breakdown) as ConsumptionInvoiceLine['pricing_breakdown']) ?? null,
			invoice_id: String(row.invoice_id),
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			is_active: row.is_active !== false,
			issue_date: toText(row.issue_date),
			document_type: toText(row.document_type),
			invoice_type: toText(row.invoice_type),
			is_legacy: row.is_legacy === true,
			consolidated_pending: row.consolidated_pending === true,
			unified_v2: row.unified_v2 === true,
			credit_type: toText(row.credit_type),
			no_charge: row.no_charge === true,
			voided: row.voided === true,
		}));

		return buildConsumption({ entries, items, lines, today: todayFor(await holdingTimezone(this.dataSource, holdingId), today) });
	}

	// ---------------------------------------------------------------- integración: almacén de datos (DWH)

	/**
	 * Consumo vigente del ítem en el MES (`YYYY-MM-01`): la entry cuyo período empieza en ese mes (con el día de ciclo del contrato el
	 * período puede empezar después del día 1). Lo usa la sincronización del almacén de datos (`BigQueryService`) para su semántica
	 * insert-only. Devuelve también el unitario efectivo: monto fijado ÷ cantidad, o el del ítem.
	 */
	async entryForMonth(holdingId: string, itemId: string, month: string): Promise<DwhEntryView | null> {
		const [row] = (await this.dataSource.query(
			`SELECT e.id, e.contract_id, e.contract_item_id, e.period_start::text AS period_start, e.quantity, e.amount_override, e.account,
				ci.unit_price, ci.unit_of_measure
			FROM consumption_entries e JOIN contract_items ci ON ci.id = e.contract_item_id
			WHERE e.holding_id = $1 AND e.contract_item_id = $2 AND date_trunc('month', e.period_start) = date_trunc('month', $3::date)
			ORDER BY e.period_start LIMIT 1`,
			[holdingId, itemId, month]
		)) as Row[];

		return row ? dwhEntryView(row) : null;
	}

	/** Entry por id (o, para un id de `quantities` anterior a la migración `1791600000000`, la entry que se copió de esa fila). */
	async entryById(holdingId: string, id: string): Promise<DwhEntryView | null> {
		const [row] = (await this.dataSource.query(
			`SELECT e.id, e.contract_id, e.contract_item_id, e.period_start::text AS period_start, e.quantity, e.amount_override, e.account,
				ci.unit_price, ci.unit_of_measure
			FROM consumption_entries e JOIN contract_items ci ON ci.id = e.contract_item_id
			WHERE e.holding_id = $1 AND (e.id::text = $2 OR e.idempotency_key = 'quantities:' || $2)
			ORDER BY (e.id::text = $2) DESC LIMIT 1`,
			[holdingId, id]
		)) as Row[];

		return row ? dwhEntryView(row) : null;
	}

	/**
	 * Registra (o, con `correction_reason`, corrige) el consumo de un ítem informado por el almacén de datos: mismo camino que la pantalla
	 * (`write`: costura `sapira.writer = 'api'`, recálculo de la Por Emitir del período —o 409 si ya se emitió—, historial, evento y rebuild
	 * del devengo del mes), con `source = 'dwh'` y sin usuaria (evento con el actor del sistema). El período es el de la línea del ítem que
	 * empieza en ese mes. El unitario del DWH distinto del del ítem entra como monto fijado (unitario × cantidad), igual que el override
	 * del front anterior. 409 `period_out_of_item` si el ítem no tiene línea en ese mes.
	 */
	async recordFromDwh(
		holdingId: string,
		contractId: string,
		itemId: string,
		month: string,
		values: { quantity: number; unit_price: number | null; account: string | null; notes: string | null; correction_reason?: string | null }
	): Promise<ConsumptionWriteResult> {
		const [line] = (await this.dataSource.query(
			`SELECT ii.billing_period_start::text AS period_start, ci.unit_price
			FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN contract_items ci ON ci.id = ii.contract_item_id
			WHERE ii.contract_item_id = $1 AND i.holding_id = $2 AND ci.contract_id = $3
				AND date_trunc('month', ii.billing_period_start) = date_trunc('month', $4::date)
			ORDER BY (i.status IS DISTINCT FROM '${CANCELLED_STATUS}') DESC, (i.status = '${PENDING_STATUS}') DESC, ii.billing_period_start
			LIMIT 1`,
			[itemId, holdingId, contractId, month]
		)) as Row[];

		if (!line) throw outOfItemConflict(month, []);
		const itemUnit = toNullableNumber(line.unit_price);
		const amountOverride = dwhAmountOverride(values.quantity, values.unit_price, itemUnit);

		return await this.write(
			contractId,
			itemId,
			String(line.period_start).slice(0, 10),
			{
				quantity: values.quantity,
				amount_override: amountOverride,
				account: values.account ?? undefined,
				notes: values.notes ?? undefined,
				correction_reason: values.correction_reason ?? undefined,
			} as UpsertConsumptionDto,
			holdingId,
			null,
			'dwh'
		);
	}

	// ---------------------------------------------------------------- lectura: pendientes de informar

	/**
	 * "Pendientes de informar" (§5): líneas medidas con período de servicio terminado y `quantity_source = pending` en
	 * facturas Por Emitir activas, con contrato, ítem, métrica, factura y su fecha de emisión. Paginado
	 * `{ data, total, currentPage, pages, limit }`. Con `contractId` (ruta por contrato) o `query.contract_id` se acota a un contrato.
	 */
	async pending(holdingId: string, query: QueryConsumptionPendingDto, contractId?: string, today = new Date()) {
		const limit = query.limit ?? DEFAULT_LIMIT;
		const page = query.page ?? 1;
		const params: unknown[] = [holdingId, todayFor(await holdingTimezone(this.dataSource, holdingId), today)];
		const where: string[] = [
			`i.holding_id = $1`,
			`i.is_active = true`,
			`i.status = '${PENDING_STATUS}'`,
			`COALESCE(i.is_legacy, false) = false`,
			`i.invoice_type IS DISTINCT FROM '${UNIFIED_INVOICE_TYPE}'`,
			`i.document_type IS DISTINCT FROM 'NC'`,
			`i.document_type IS DISTINCT FROM 'ND'`,
			`p.quantity_type = 'metered'`,
			`ii.quantity_source = 'pending'`,
			`ii.billing_period_end < $2::date`,
			`c.deleted_at IS NULL`,
		];
		const add = (clause: string, value: unknown) => {
			params.push(value);
			where.push(clause.replace('?', `$${params.length}`));
		};

		if (contractId ?? query.contract_id) add(`c.id = ?::uuid`, contractId ?? query.contract_id);
		if (query.period) add(`to_char(ii.billing_period_start, 'YYYY-MM') = ?`, query.period);
		if (query.client_id) add(`c.client_id = ?::uuid`, query.client_id);
		if (query.company_id) add(`c.company_id = ?::uuid`, query.company_id);
		const from = `FROM invoice_items ii
			JOIN invoices i ON i.id = ii.invoice_id
			JOIN contract_items ci ON ci.id = ii.contract_item_id
			JOIN prices p ON p.id = ci.price_id
			LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id
			JOIN contracts c ON c.id = ci.contract_id
			LEFT JOIN clients cl ON cl.id = c.client_id
			WHERE ${where.join(' AND ')}`;
		const [[count], rows] = await Promise.all([
			this.dataSource.query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params),
			this.dataSource.query<Row[]>(
				`SELECT ii.id AS line_id, ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end,
					ii.quantity, ii.subtotal_contract_currency,
					i.id AS invoice_id, i.invoice_number, i.issue_date::text AS issue_date, i.status, i.contract_currency, i.invoice_currency,
					c.id AS contract_id, c.contract_number, c.client_id, cl.name_commercial AS client_name, c.company_id,
					ci.id AS item_id, ci.product_name, ci.account, ci.unit_of_measure,
					bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit, bm.aggregation AS metric_aggregation
				${from}
				ORDER BY ii.billing_period_start, c.contract_number, ci.product_name, ii.id
				LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
				params
			),
		]);
		const total = toNumber(count?.total);

		return {
			data: rows.map((row) => ({
				line_id: String(row.line_id),
				period_start: toText(row.billing_period_start),
				period_end: toText(row.billing_period_end),
				base_quantity: toNullableNumber(row.quantity),
				base_amount: toNullableNumber(row.subtotal_contract_currency),
				contract: {
					id: String(row.contract_id),
					contract_number: toText(row.contract_number),
					client_id: toText(row.client_id),
					client_name: toText(row.client_name),
					company_id: toText(row.company_id),
				},
				item: {
					id: String(row.item_id),
					product_name: toText(row.product_name),
					account: toText(row.account) || null,
					unit_of_measure: toText(row.unit_of_measure),
				},
				metric: row.metric_id
					? {
							id: String(row.metric_id),
							code: toText(row.metric_code),
							name: toText(row.metric_name),
							unit: toText(row.metric_unit),
							aggregation: toText(row.metric_aggregation),
						}
					: null,
				invoice: {
					id: String(row.invoice_id),
					invoice_number: toText(row.invoice_number),
					status: toText(row.status),
					issue_date: toText(row.issue_date),
					contract_currency: toText(row.contract_currency),
					invoice_currency: toText(row.invoice_currency),
				},
			})),
			total,
			currentPage: page,
			pages: Math.max(1, Math.ceil(total / limit)),
			limit,
		};
	}

	// ---------------------------------------------------------------- escritura

	/**
	 * `POST /contracts/:id/consumption/preview`: mismo cálculo que el PUT, sin escribir; los 409/400 se devuelven igual. Con
	 * `apply_as = additional | reissue` muestra la complementaria o la reemisión que se crearía (§4.4).
	 */
	async preview(idOrNumber: string, itemId: string, periodStart: string, dto: UpsertConsumptionDto, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const item = await this.loadMeteredItem(this.dataSource, itemId, contract.id, holdingId);
		const lines = await this.loadPeriodLines(this.dataSource, item.id, holdingId, periodStart);
		const existing = await this.loadEntry(this.dataSource, item.id, periodStart);
		const plan = this.plan(item, lines, existing, periodStart, dto);

		const base = {
			entry: { ...plan.entry, id: existing?.id ?? null },
			line: plan.line,
			lines: plan.parts.map(stripAmounts),
			invoice: plan.invoice,
			event: plan.event,
			mode: plan.mode,
			apply_as: plan.apply_as,
			on_issued: onIssuedOf(plan.apply_as),
			complements_invoice: plan.reference ? this.referenceView(plan.reference) : null,
			...plan.outcome,
			credit_note: null as ConsumptionWriteResult['credit_note'],
			cancelled_invoice: null as ConsumptionWriteResult['cancelled_invoice'],
			created: {} as ConsumptionWriteResult['created'],
			would_correct: Boolean(existing),
			warnings: plan.warnings,
			warning_codes: plan.warning_codes,
		};

		if (plan.mode === 'additional' && plan.reference && plan.additional && plan.priced) {
			const header = await this.loadInvoiceHeader(this.dataSource, plan.reference.invoice_id, holdingId);
			const draft = this.additionalDraft(item, plan, header, todayFor(await holdingTimezone(this.dataSource, holdingId)));

			const [row] = draft.lines.map(stripAmounts);
			const warnings = [...base.warnings];
			const warningCodes = [...base.warning_codes];

			addFittedWarning(warnings, warningCodes, draft.fitted_lines, item.description_max_chars);

			return {
				...base,
				line: this.lineFromRow(plan.priced, row, null),
				lines: [row],
				invoice: draft.invoice,
				warnings,
				warning_codes: warningCodes,
			};
		}
		if (plan.mode === 'reissue' && plan.issued && plan.priced) {
			const header = await this.loadInvoiceHeader(this.dataSource, plan.issued.invoice_id, holdingId);
			const issuedLines = await this.loadInvoiceLines(this.dataSource, header.id, holdingId);
			const draft = this.reissueDraft(item, plan, header, issuedLines, todayFor(await holdingTimezone(this.dataSource, holdingId)));
			const warnings = [...base.warnings];
			const warningCodes = [...base.warning_codes];

			addFittedWarning(warnings, warningCodes, draft.fitted_lines, item.description_max_chars);

			return {
				...base,
				warnings,
				warning_codes: warningCodes,
				lines: draft.item_lines,
				invoice: draft.invoice,
				credit_note: { id: null, number: null, total: draft.credit_note.total },
				cancelled_invoice: { id: header.id, invoice_number: header.invoice_number },
			};
		}

		return base;
	}

	/**
	 * `PUT /contracts/:id/items/:itemId/consumption/:periodStart`: upsert idempotente + recálculo de la Por Emitir del período
	 * (§4.3) en **una transacción**: entry (revisión +1 con motivo obligatorio), fila en `consumption_entry_revisions`, líneas y
	 * encabezado recalculados, `revenue_schedule_rebuild(contrato, mes)` y evento. `apply_as` (§4.4): `additional` deja la
	 * factura del período (Por Emitir o emitida) intacta y crea una complementaria Por Emitir con la diferencia; `reissue` (solo
	 * emitidas) anula con NC espejo y crea la factura nueva del período.
	 */
	async upsert(
		idOrNumber: string,
		itemId: string,
		periodStart: string,
		dto: UpsertConsumptionDto,
		holdingId: string,
		authId: string
	): Promise<ConsumptionWriteResult> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.write(contract.id, itemId, periodStart, dto, holdingId, userId, 'manual');
	}

	/**
	 * `POST /contracts/:id/consumption/bulk`: una transacción por fila; ninguna fila salta la regla 4 (siempre `apply_as = recompute`).
	 * Devuelve `{ applied, skipped[{ row, reason }], results[] }`.
	 */
	async bulk(idOrNumber: string, dto: ConsumptionBulkDto, holdingId: string, authId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const items = (await this.dataSource.query(
			`SELECT ci.id, ci.product_name, ci.account FROM contract_items ci WHERE ci.contract_id = $1 AND ci.holding_id = $2`,
			[contract.id, holdingId]
		)) as Row[];
		const norm = (value: unknown) => (toText(value) ?? '').trim().toLowerCase();
		const results: Array<{ row: number; item_id: string; period_start: string; entry_id: string; revision: number; event: string }> = [];
		const skipped: Array<{ row: number; reason: string }> = [];

		for (const [index, row] of dto.rows.entries()) {
			try {
				let itemId = row.item_id;

				if (!itemId) {
					if (!row.product_name) throw new BadRequestException('Indica el ítem (item_id) o el producto con su cuenta');
					const matches = items.filter(
						(item) => norm(item.product_name) === norm(row.product_name) && norm(item.account) === norm(row.account)
					);

					if (!matches.length)
						throw new NotFoundException(
							`No hay un ítem "${row.product_name}"${row.account ? ` con cuenta "${row.account}"` : ''} en el contrato`
						);
					if (matches.length > 1)
						throw new BadRequestException(`Hay ${matches.length} ítems "${row.product_name}" con la misma cuenta: indica item_id`);
					itemId = String(matches[0].id);
				}
				const result = await this.write(
					contract.id,
					itemId,
					row.period_start,
					{
						quantity: row.quantity,
						amount_override: row.amount_override,
						notes: row.notes,
						correction_reason: row.correction_reason,
						idempotency_key: row.idempotency_key,
					},
					holdingId,
					userId,
					'csv'
				);

				results.push({
					row: index,
					item_id: itemId,
					period_start: row.period_start,
					entry_id: result.entry.id,
					revision: result.entry.revision,
					event: result.event,
				});
			} catch (error) {
				const message = error instanceof HttpException ? this.messageOf(error) : error instanceof Error ? error.message : String(error);

				skipped.push({ row: index, reason: message });
			}
		}

		return { applied: results.length, skipped, results };
	}

	private messageOf(error: HttpException): string {
		const body = error.getResponse();

		if (typeof body === 'string') return body;
		const message = (body as { message?: unknown }).message;

		return Array.isArray(message) ? message.join(', ') : String(message ?? error.message);
	}

	// ---------------------------------------------------------------- núcleo (§4.3 y §4.4)

	/** Lo que se escribiría: entry propuesta, filas recalculadas, encabezado y evento. Lanza los 409/400 explicados. */
	private plan(
		item: MeteredItem,
		lines: ConsumptionPeriodLine[],
		existing: EntryView | null,
		periodStart: string,
		dto: UpsertConsumptionDto
	): WritePlan {
		// Solo ítems por consumo (Domi 05-10): un ítem fijo no recibe cantidad por período; se corrige con "Editar factura" de la Por Emitir.
		if (!item.is_metered) throw fixedItemConflict(item.product_name);
		const classification = classifyPeriodLines(lines);

		if (classification.state === 'none') {
			throw outOfItemConflict(periodStart, [...new Set(lines.map((line) => line.billing_period_start))].sort());
		}
		const applyAs = resolveApplyAs(dto);
		const anchor = classification.state === 'open' ? classification.target : classification.state === 'issued' ? classification.issued : null;
		const periodEnd = anchor?.billing_period_end ?? lines[0].billing_period_end;
		const warnings = [...(classification.state === 'open' || classification.state === 'void_only' ? classification.warnings : [])];
		const entry: Omit<EntryView, 'id'> = {
			contract_item_id: item.id,
			period_start: periodStart,
			period_end: periodEnd,
			quantity: Number(dto.quantity),
			amount_override: dto.amount_override ?? null,
			apply_item_discount: dto.apply_item_discount !== false,
			account: dto.account?.trim() || existing?.account || null,
			is_estimated: dto.is_estimated === true,
			source: 'manual',
			revision: existing ? existing.revision + 1 : 1,
			correction_reason: existing ? dto.correction_reason?.trim() || null : null,
			notes: dto.notes ?? existing?.notes ?? null,
			idempotency_key: dto.idempotency_key?.trim() || null,
			invoice_id: null,
			created_at: existing?.created_at ?? null,
			updated_at: null,
		};
		const empty: WritePlan = {
			entry,
			event: existing ? 'CONSUMPTION_CORRECTED' : 'CONSUMPTION_RECORDED',
			mode: 'none',
			warnings,
			warning_codes: [],
			no_charge: null,
			priced: null,
			target: null,
			target_lines: [],
			parts: [],
			issued: null,
			issued_lines: [],
			reference: null,
			reference_lines: [],
			additional: null,
			outcome: NO_ISSUED,
			apply_as: applyAs,
			line: null,
			invoice: null,
		};
		const priced = anchor && this.priceFor(item, anchor, entry);

		// Paso 4 (§4.3/§4.4): la emitida no se pisa. `recompute` → 409 con la emitida y si la complementaria es posible; en un
		// ítem estándar el 409 es `item_not_metered` (la cantidad solo entra como complementaria o reemisión).
		if (classification.state === 'issued' && applyAs === 'recompute') {
			if (!item.is_metered) throw notMeteredConflict(item.product_name, classification.issued);
			throw issuedConflict(classification.issued, additionalDifference(priced!, classification.issued_lines));
		}
		const errors: FieldError[] = [];

		if (existing && !dto.correction_reason?.trim())
			errors.push({ field: 'correction_reason', message: 'Escribe el motivo de la corrección: el período ya tiene consumo registrado' });
		if (errors.length) throw validationException(errors);
		if (classification.state === 'void_only' || !priced) return empty;
		warnings.push(...priced.warnings);

		if (classification.state === 'issued') {
			const { issued, issued_lines: issuedLines } = classification;
			const diff = additionalDifference(priced, issuedLines);
			const outcome = issuedOutcome(issued, diff);

			if (applyAs === 'additional') {
				if (diff.difference <= 0) throw noAdditionalConflict(issued, diff);

				return {
					...empty,
					event: 'CONSUMPTION_ADDITIONAL_INVOICE',
					mode: 'additional',
					priced,
					issued,
					issued_lines: issuedLines,
					reference: issued,
					reference_lines: issuedLines,
					additional: diff,
					outcome,
					line: { ...priced, id: null, invoice_id: null, tax_amount: 0, total: 0 },
				};
			}

			return {
				...empty,
				event: 'CONSUMPTION_REISSUE',
				mode: 'reissue',
				priced,
				issued,
				issued_lines: issuedLines,
				outcome,
				line: { ...priced, id: null, invoice_id: null, tax_amount: 0, total: 0 },
			};
		}

		const { target, target_lines: targetLines, complements } = classification;

		// Por Emitir + `additional` (§4.4): la factura del período no se toca; la diferencia contra lo que ya lleva (más lo que
		// lleve la emitida a la que complementa, si es una complementaria) va a una factura nueva Por Emitir con fecha de hoy.
		if (applyAs === 'additional') {
			const carried = [...(complements?.issued_lines ?? []), ...targetLines];
			const diff = additionalDifference(priced, carried);

			if (diff.difference <= 0) throw noAdditionalConflict(target, diff);

			return {
				...empty,
				event: 'CONSUMPTION_ADDITIONAL_INVOICE',
				mode: 'additional',
				priced,
				issued: complements?.issued ?? null,
				issued_lines: complements?.issued_lines ?? [],
				reference: target,
				reference_lines: carried,
				additional: diff,
				outcome: {
					issued_invoice: complements ? issuedOutcome(complements.issued, null).issued_invoice : null,
					additional_amount: diff.difference,
					additional_allowed: true,
					additional_reason: null,
				},
				line: { ...priced, id: null, invoice_id: null, tax_amount: 0, total: 0 },
			};
		}
		// Protección de ediciones manuales (spec facturas §3.4): una fila de la Por Emitir editada a mano (`quantity_source = manual`) no se
		// reescribe; el consumo queda registrado y la diferencia contra el plan la muestra el conciliador de desvíos de la factura.
		if (targetLines.some((line) => line.quantity_source === MANUAL_QUANTITY_SOURCE)) {
			return {
				...empty,
				warnings: [
					...warnings,
					`La línea de "${item.product_name ?? 'Producto'}" en la factura ${target.invoice_number ?? target.invoice_id} fue editada a mano: el consumo se registra pero la factura no se recalcula (edítala desde la factura)`,
				],
				warning_codes: [MANUAL_EDIT_KEPT],
			};
		}
		if (applyAs === 'reissue') warnings.push('La factura del período está Por Emitir: se recalcula (reemitir solo aplica a facturas emitidas)');
		let effective = priced;
		let outcome: IssuedOutcomeView = NO_ISSUED;
		let additional: AdditionalDifference | null = null;

		if (complements) {
			// La Por Emitir del período es una complementaria: se recalcula la diferencia contra la emitida, nunca el total.
			additional = additionalDifference(priced, complements.issued_lines);
			outcome = issuedOutcome(complements.issued, additional);
			if (additional.difference <= 0) throw noAdditionalConflict(complements.issued, additional);
			effective = additionalPricedLine(priced, additional, complements.issued);
			warnings.push(
				`La factura Por Emitir del período es complementaria de ${complements.issued.invoice_number ?? complements.issued.invoice_id}${
					isPendingLine(complements.issued) ? ' (Por Emitir)' : ''
				}: se recalcula solo la diferencia`
			);
		}
		const fit: FitCounter = { count: 0 };
		const parts = complements
			? this.singlePart(item, effective, target, targetLines, ' - Consumo adicional sobre ', fit)
			: this.buildParts(item, effective, target, targetLines, fit);
		const taxAmount = round2(parts.reduce((sum, part) => sum + part.tax_amount, 0));
		// Sin cobro (spec facturas §3.4): si la factura queda con TODAS sus líneas en 0 pasa a Cancelada; una sin cobro que recupera
		// cantidad vuelve a Por Emitir. Con borrador en el ERP también (aviso `erp_draft_stale`: eliminarlo allí y restablecerlo aquí).
		const allZero = parts.every((part) => part.quantity === 0 && part.subtotal === 0) && (target.other_nonzero_lines ?? 0) === 0;
		// Un origen consolidado (inactivo, dentro de un unificado Por Emitir) nunca pasa a sin cobro: el documento es el unificado.
		const noCharge: WritePlan['no_charge'] = target.consolidated_pending
			? null
			: target.no_charge && !allZero
				? 'reverted'
				: !target.no_charge && target.status === PENDING_STATUS && allZero
					? 'becomes'
					: null;
		const warningCodes: string[] = [];

		// Borrador en el ERP: no bloquea (decisión de Domi 01-10); el recálculo sigue y se avisa que el borrador del ERP quedó desactualizado.
		if (hasErpDraft(target)) {
			warnings.push(`${ERP_DRAFT_STALE_MESSAGE} (${target.invoice_number ?? `del ${target.issue_date ?? target.invoice_id}`})`);
			warningCodes.push(ERP_DRAFT_STALE_CODE);
		}
		if (noCharge === 'becomes') {
			warnings.push(
				'Todas las líneas de la factura quedan en 0: pasa a Cancelada "sin cobro" (vuelve a Por Emitir si luego se registra consumo)'
			);
			warningCodes.push('becomes_no_charge');
		} else if (noCharge === 'reverted') {
			warnings.push('La factura estaba sin cobro: con este consumo vuelve a Por Emitir con sus líneas recalculadas');
			warningCodes.push('no_charge_reverted');
		}
		addFittedWarning(warnings, warningCodes, fit.count, item.description_max_chars);

		return {
			...empty,
			mode: 'recompute',
			warning_codes: warningCodes,
			no_charge: noCharge,
			priced: effective,
			target,
			target_lines: targetLines,
			parts,
			issued: complements?.issued ?? null,
			issued_lines: complements?.issued_lines ?? [],
			additional,
			outcome,
			entry: { ...entry, invoice_id: target.invoice_id },
			line: {
				...effective,
				id: parts[0]?.id ?? null,
				invoice_id: target.invoice_id,
				tax_amount: taxAmount,
				total: round2(effective.subtotal + taxAmount),
			},
			invoice: {
				id: target.invoice_id,
				invoice_number: target.invoice_number,
				status: noCharge === 'becomes' ? 'Cancelada' : noCharge === 'reverted' ? PENDING_STATUS : target.status,
				issue_date: target.issue_date,
				currency: target.invoice_currency,
				fx: target.fx,
				// Encabezado estimado: Σ líneas con las de este ítem ya recalculadas (el definitivo se relee al escribir).
				subtotal: round2(
					lines
						.filter((line) => line.invoice_id === target.invoice_id && !targetLines.some((own) => own.line_id === line.line_id))
						.reduce((sum, line) => sum + line.subtotal, 0) + effective.subtotal
				),
				tax: 0,
				total: 0,
			},
		};
	}

	/**
	 * Línea tarifada con la cantidad informada: el modelo de precio del ítem medido, o cantidad × unitario del período para un
	 * ítem estándar (el unitario que la activación dejó en la línea; si falta, el del ítem). El descuento es el de la línea.
	 */
	private priceFor(
		item: MeteredItem,
		anchor: ConsumptionPeriodLine,
		entry: Pick<EntryView, 'quantity' | 'amount_override' | 'apply_item_discount' | 'is_estimated'>
	) {
		const options: PriceLineOptions = {
			amount_override: entry.amount_override,
			apply_item_discount: entry.apply_item_discount,
			quantity_source: entry.is_estimated ? 'estimated' : 'consumption',
		};
		const discount = discountPctFor(anchor, item);

		if (item.is_metered && item.price) return priceLine(item.price, entry.quantity, discount, options);
		const unitPrice =
			anchor.unit_price !== null && anchor.unit_price !== undefined && anchor.unit_price !== 0 ? anchor.unit_price : item.unit_price;

		return priceStandardLine(unitPrice, entry.quantity, discount, options);
	}

	private referenceView(line: ConsumptionPeriodLine): NonNullable<ConsumptionWriteResult['complements_invoice']> {
		return { id: line.invoice_id, invoice_number: line.invoice_number, status: line.status, issue_date: line.issue_date };
	}

	/** Una sola fila (la complementaria recalculada) con la glosa base + sufijo fijo, reescribiendo la existente. */
	private singlePart(
		item: MeteredItem,
		priced: PricedLine,
		reference: Pick<ConsumptionPeriodLine, 'tax_rate' | 'fx' | 'billing_period_start' | 'billing_period_end' | 'invoice_number' | 'invoice_id'>,
		existingLines: ConsumptionPeriodLine[],
		suffix: string,
		fit?: FitCounter
	): WritePlan['parts'] {
		const invoiced = priced.breakdown.find((subline) => subline.kind === 'invoiced');
		const issuedLabel = invoiced ? invoicedReferenceName(invoiced.label) || invoiced.invoice_id || '' : '';
		const base = lineDescription(item.product_name ?? 'Producto', item.account, reference.billing_period_start, reference.billing_period_end);
		const amounts = lineAmounts(priced, reference.tax_rate, reference.fx);
		const description = this.suffixedGlosa(item, reference, `${base}${suffix}${issuedLabel}`.trim(), `${suffix}${issuedLabel}`, fit);

		return [
			{
				id: existingLines[0]?.line_id ?? null,
				description,
				quantity: priced.quantity,
				unit_price: priced.effective_unit_price,
				subtotal: priced.subtotal,
				tax_amount: amounts.tax_amount_contract_currency,
				total: amounts.total_contract_currency,
				quantity_source: priced.quantity_source,
				pricing_breakdown: priced.breakdown,
				amounts,
			},
		];
	}

	/** Contexto de la glosa de hoy (producto, cuenta y período) para ajustarla al límite. */
	private glosaContext(
		item: MeteredItem,
		reference: Pick<ConsumptionPeriodLine, 'billing_period_start' | 'billing_period_end'>,
		extra: Partial<DescriptionContext> = {}
	): DescriptionContext {
		return {
			line_kind: 'standard',
			product_name: item.product_name ?? 'Producto',
			account: item.account,
			period_start: reference.billing_period_start,
			period_end: reference.billing_period_end,
			...extra,
		};
	}

	/** Glosa base + sufijo fijo ("Consumo adicional sobre …"), ajustada al límite: el sufijo es texto libre al final. */
	private suffixedGlosa(
		item: MeteredItem,
		reference: Pick<ConsumptionPeriodLine, 'billing_period_start' | 'billing_period_end'>,
		legacy: string,
		suffix: string,
		fit?: FitCounter
	): string {
		const text = suffix.replace(/^\s*-\s*/, '').trim();
		const template: DescriptionTemplate = { blocks: [...BASE_BLOCKS, ...(text ? [{ type: 'text' as const, text }] : [])] };

		return fitConsumptionGlosa(legacy, template, this.glosaContext(item, reference), item.description_max_chars, fit);
	}

	/**
	 * Filas de factura del ítem y período (§3.8): `single` reescribe la fila existente (una) con la glosa base + detalle;
	 * `per_tier` reemplaza el conjunto por una fila por tramo/paquete/asiento más una por ajuste, con el IVA repartido.
	 */
	private buildParts(
		item: MeteredItem,
		priced: PricedLine,
		reference: Pick<ConsumptionPeriodLine, 'tax_rate' | 'fx' | 'billing_period_start' | 'billing_period_end' | 'description'>,
		existingLines: ConsumptionPeriodLine[],
		fit?: FitCounter
	): WritePlan['parts'] {
		const base = lineDescription(item.product_name ?? 'Producto', item.account, reference.billing_period_start, reference.billing_period_end);
		const source = priced.quantity_source;

		if (item.price?.invoice_line_mode === 'per_tier') {
			const split = splitInvoiceLines(priced);
			// Las filas se reinsertan: una glosa escrita a mano (`description_locked`) se conserva en la fila del mismo tramo (`line_index`; una fila
			// única anterior cuenta como la 0).
			const locked = new Map<number, string>();

			existingLines.forEach((line, position) => {
				if (!line.description_locked) return;
				const own = (line.pricing_breakdown ?? []).find((subline) => subline.line_index !== undefined && subline.line_index !== null);

				locked.set(own?.line_index ?? position, line.description ?? '');
			});
			const taxes = distributeTax(
				split.map((part) => part.subtotal),
				reference.tax_rate,
				split.map((part) => part.part === 'charge')
			);

			return split.map((part, index) => {
				const amounts = lineAmounts(
					{ quantity: part.quantity, effective_unit_price: part.unit_price, subtotal: part.subtotal },
					reference.tax_rate,
					reference.fx,
					taxes[index]
				);

				return {
					id: null,
					// Glosa generada: se ajusta al límite del documento; una escrita a mano (`description_locked`) no se toca.
					description:
						locked.get(part.index) ??
						fitConsumptionGlosa(
							asciiGlosa(`${base} - ${part.label}`),
							DEFAULT_TEMPLATE,
							this.glosaContext(item, reference, { line_kind: 'per_tier', tier_label: part.label }),
							item.description_max_chars,
							fit
						),
					description_locked: locked.has(part.index),
					quantity: part.quantity,
					unit_price: part.unit_price,
					subtotal: part.subtotal,
					tax_amount: amounts.tax_amount_contract_currency,
					total: amounts.total_contract_currency,
					quantity_source: source,
					pricing_breakdown: part.breakdown,
					part: { part: part.part, index: part.index, count: part.count },
					amounts,
				};
			});
		}
		const existing = existingLines[0] ?? null;
		const amounts = lineAmounts(priced, reference.tax_rate, reference.fx);
		const glosaBase = existing?.description ? baseGlosa(existing.description) : base;
		// Con la glosa de hoy como base se ajusta con la plantilla estándar; con una base propia (editada), esa base es texto libre.
		const singleTemplate: DescriptionTemplate =
			glosaBase === base
				? DEFAULT_TEMPLATE
				: {
						blocks: [
							{ type: 'text', text: glosaBase },
							{ type: 'tier', format: 'detail' },
						],
					};
		const singleContext = this.glosaContext(item, reference, {
			line_kind: item.is_metered ? 'single' : 'standard',
			breakdown: item.is_metered ? priced.breakdown : null,
		});

		return [
			{
				id: existing?.line_id ?? null,
				// Respeta una glosa editada a mano: solo se reemplaza el detalle de precio. En ítems estándar la glosa no cambia
				// (como las cantidades variables del front viejo: solo cantidad y montos).
				description: fitConsumptionGlosa(
					item.is_metered ? describeSingleLine(glosaBase, priced) : glosaBase,
					singleTemplate,
					singleContext,
					item.description_max_chars,
					fit
				),
				quantity: priced.quantity,
				unit_price: priced.effective_unit_price,
				subtotal: priced.subtotal,
				tax_amount: amounts.tax_amount_contract_currency,
				total: amounts.total_contract_currency,
				quantity_source: source,
				pricing_breakdown: priced.breakdown,
				amounts,
			},
		];
	}

	/** `line` de la respuesta a partir de la única fila de la complementaria: lo que de verdad va a la factura (la diferencia). */
	private lineFromRow(priced: PricedLine, row: ConsumptionLineRow, invoiceId: string | null): NonNullable<ConsumptionWriteResult['line']> {
		return {
			...priced,
			quantity: row.quantity,
			billable_quantity: row.quantity,
			effective_unit_price: row.unit_price,
			subtotal: row.subtotal,
			breakdown: row.pricing_breakdown,
			id: row.id,
			invoice_id: invoiceId,
			tax_amount: row.tax_amount,
			total: row.total,
		};
	}

	/** Tipo de cambio de una factura nueva del período: misma moneda → 1; política fija → la tasa de la emitida; spot → null. */
	private newInvoiceFx(header: IssuedInvoiceHeader): number | null {
		if ((header.invoice_currency ?? '').toUpperCase() === (header.contract_currency ?? '').toUpperCase()) return 1;

		return header.fx_invoice_policy === 'fixed' ? header.fx : null;
	}

	/** Tipo de documento de una factura nueva: el del contrato (si cambió) o el de la emitida. */
	private newDocumentType(header: IssuedInvoiceHeader): { document_type: string; export_type: number } {
		const documentType = header.contract_document_type ?? header.document_type ?? 'FACTURA';

		return { document_type: documentType, export_type: documentType === 'FACTURA_EXPORTACION' ? 1 : (header.export_type ?? 0) };
	}

	private newDueDate(header: IssuedInvoiceHeader, issueDate: string): string {
		return computeDueDate(
			issueDate,
			cleanPaymentTerms(header.payment_terms) ?? cleanPaymentTerms(header.entity_payment_terms),
			header.company_country
		);
	}

	/**
	 * Complementaria (§4.4): una sola línea con la diferencia, encabezado = esa línea, mismo receptor/emisor/moneda/política FX que
	 * la factura de referencia (la emitida, o la Por Emitir del período). Fecha de emisión = hoy; vencimiento según condición de pago.
	 */
	private additionalDraft(item: MeteredItem, plan: WritePlan, header: IssuedInvoiceHeader, issueDay: string) {
		const issued = plan.reference!;
		const pending = isPendingLine(issued);
		const fx = this.newInvoiceFx(header);
		const priced = additionalPricedLine(plan.priced!, plan.additional!, {
			invoice_id: header.id,
			invoice_number: header.invoice_number,
			status: header.status,
		});
		const amounts = lineAmounts(priced, header.tax_rate, fx);
		const base = lineDescription(item.product_name ?? 'Producto', item.account, issued.billing_period_start, issued.billing_period_end);
		const issueDate = issueDay;
		const fit: FitCounter = { count: 0 };
		const suffix = ` - Consumo adicional sobre ${header.invoice_number ?? header.id}`;
		const line: ConsumptionLineRow & { amounts: LineAmounts } = {
			id: null,
			description: this.suffixedGlosa(item, issued, `${base}${suffix}`, suffix, fit),
			quantity: priced.quantity,
			unit_price: priced.effective_unit_price,
			subtotal: priced.subtotal,
			tax_amount: amounts.tax_amount_contract_currency,
			total: amounts.total_contract_currency,
			quantity_source: priced.quantity_source,
			pricing_breakdown: priced.breakdown,
			amounts,
		};
		const headerTotals = headerAmounts(priced.subtotal, amounts.tax_amount_contract_currency, header.tax_rate, fx);
		const notes = `Consumo adicional del período ${issued.billing_period_start} a ${issued.billing_period_end} sobre ${
			header.invoice_number ?? `${pending ? 'la factura Por Emitir ' : ''}${header.id}`
		}: ${plan.entry.quantity}${item.metric?.unit ? ` ${item.metric.unit}` : ''} informados, ${plan.additional!.already_quantity} ${
			pending ? 'ya incluidos' : 'ya facturados'
		} (${header.contract_currency ?? ''} ${plan.additional!.already_invoiced})`.replace(/\s+/g, ' ');

		return {
			fx,
			issue_date: issueDate,
			due_date: this.newDueDate(header, issueDate),
			...this.newDocumentType(header),
			fitted_lines: fit.count,
			notes,
			header: headerTotals,
			lines: [line],
			newLines: [
				{
					contract_item_id: item.id,
					product_id: issued.product_id ?? null,
					description: line.description,
					quantity: line.quantity,
					unit_of_measure: issued.unit_of_measure ?? item.unit_of_measure,
					discount_pct: issued.discount_pct,
					amounts,
					billing_period_start: issued.billing_period_start,
					billing_period_end: issued.billing_period_end,
					quantity_source: priced.quantity_source,
					pricing_breakdown: priced.breakdown,
				} satisfies NewLine,
			],
			invoice: {
				id: '',
				invoice_number: null,
				status: PENDING_STATUS,
				issue_date: issueDate,
				currency: header.invoice_currency,
				fx,
				subtotal: headerTotals.amount_contract_currency,
				tax: headerTotals.vat,
				total: headerTotals.total_invoice_currency ?? round2(headerTotals.amount_contract_currency + amounts.tax_amount_contract_currency),
			} as ConsumptionInvoiceView,
		};
	}

	/**
	 * Reemisión (§4.4): NC espejo completa de la emitida (ratio 1, `issue_error`, `cancellation`) y factura nueva Por Emitir del
	 * período con todas las líneas de la emitida, salvo las de este ítem y período, que se reemplazan por las recalculadas.
	 */
	private reissueDraft(item: MeteredItem, plan: WritePlan, header: IssuedInvoiceHeader, issuedLines: IssuedLineRow[], issueDay: string) {
		const issued = plan.issued!;
		const fx = this.newInvoiceFx(header);
		const replaced = new Set(plan.issued_lines.map((line) => line.line_id));
		const fit: FitCounter = { count: 0 };
		// Glosas escritas a mano de la emitida (`description_locked`): se copian bloqueadas a la reemisión (por tramo en `per_tier`; la única en `single`).
		const lockedOwn = plan.issued_lines.filter((line) => line.description_locked);
		const parts = this.buildParts(item, plan.priced!, { ...issued, fx }, item.price?.invoice_line_mode === 'per_tier' ? lockedOwn : [], fit).map(
			(part) =>
				item.price?.invoice_line_mode !== 'per_tier' && lockedOwn.length
					? { ...part, description: lockedOwn[0].description ?? part.description, description_locked: true }
					: part
		);
		const kept = issuedLines.filter((line) => !replaced.has(line.id));
		const newLines: NewLine[] = [
			...kept.map((line) => ({
				contract_item_id: line.contract_item_id,
				product_id: line.product_id,
				description: line.description ?? '',
				quantity: line.quantity,
				unit_of_measure: line.unit_of_measure,
				discount_pct: line.discount_pct,
				amounts: lineAmounts(
					{ quantity: line.quantity, effective_unit_price: line.unit_price, subtotal: line.subtotal },
					header.tax_rate,
					fx,
					line.tax_amount
				),
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
				quantity_source: line.quantity_source,
				pricing_breakdown: line.pricing_breakdown,
				description_locked: line.description_locked === true,
			})),
			...parts.map((part) => ({
				contract_item_id: item.id,
				product_id: issued.product_id ?? null,
				description: part.description,
				quantity: part.quantity,
				unit_of_measure: issued.unit_of_measure ?? item.unit_of_measure,
				discount_pct: issued.discount_pct,
				amounts: part.amounts,
				billing_period_start: issued.billing_period_start,
				billing_period_end: issued.billing_period_end,
				quantity_source: part.quantity_source,
				pricing_breakdown: part.pricing_breakdown,
				description_locked: part.description_locked === true,
			})),
		];
		const subtotal = round2(newLines.reduce((sum, line) => sum + line.amounts.subtotal_contract_currency, 0));
		const tax = round2(newLines.reduce((sum, line) => sum + line.amounts.tax_amount_contract_currency, 0));
		const headerTotals = headerAmounts(subtotal, tax, header.tax_rate, fx);
		const creditSubtotal = round2(issuedLines.reduce((sum, line) => sum + line.subtotal, 0));
		const creditTax = round2(issuedLines.reduce((sum, line) => sum + line.tax_amount, 0));
		const issueDate = issueDay;
		const notes = `Reemisión de ${header.invoice_number ?? header.id} por consumo corregido de "${item.product_name ?? ''}" del período ${
			issued.billing_period_start
		} a ${issued.billing_period_end} (la emitida se anula con nota de crédito espejo)`.replace(/\s+/g, ' ');

		return {
			fx,
			issue_date: issueDate,
			due_date: this.newDueDate(header, issueDate),
			...this.newDocumentType(header),
			fitted_lines: fit.count,
			notes,
			header: headerTotals,
			lines: newLines,
			item_lines: parts.map(stripAmounts),
			credit_note: { subtotal: -creditSubtotal, tax: -creditTax, total: -round2(creditSubtotal + creditTax) },
			invoice: {
				id: '',
				invoice_number: null,
				status: PENDING_STATUS,
				issue_date: issueDate,
				currency: header.invoice_currency,
				fx,
				subtotal: headerTotals.amount_contract_currency,
				tax: headerTotals.vat,
				total: headerTotals.total_invoice_currency ?? round2(subtotal + tax),
			} as ConsumptionInvoiceView,
		};
	}

	private async write(
		contractId: string,
		itemId: string,
		periodStart: string,
		dto: UpsertConsumptionDto,
		holdingId: string,
		userId: string | null,
		source: ConsumptionWriteSource
	): Promise<ConsumptionWriteResult> {
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia (los triggers legacy no corren; la API escribe cada campo).
			await setApiWriter(runner);
			// Lock del contrato antes que nada (mismo orden que modificaciones y facturas: contrato → facturas → líneas). El cierre de períodos
			// NO bloquea consumos (Domi 03-10: protege solo contratos e ítems; pagos, facturas y consumos se registran o mueven en meses cerrados).
			await this.lockContract(runner, contractId, holdingId);
			const item = await this.loadMeteredItem(runner, itemId, contractId, holdingId);

			if (dto.idempotency_key?.trim()) {
				const [duplicate] = (await runner.query(
					`SELECT e.id, e.contract_item_id, e.period_start::text AS period_start FROM consumption_entries e WHERE e.holding_id = $1 AND e.idempotency_key = $2`,
					[holdingId, dto.idempotency_key.trim()]
				)) as Row[];

				if (duplicate) {
					const entry = await this.loadEntry(runner, String(duplicate.contract_item_id), String(duplicate.period_start));

					await runner.rollbackTransaction();

					return {
						entry: entry!,
						line: null,
						lines: [],
						invoice: null,
						event: entry!.revision > 1 ? 'CONSUMPTION_CORRECTED' : 'CONSUMPTION_RECORDED',
						mode: 'none',
						apply_as: resolveApplyAs(dto),
						on_issued: onIssuedOf(resolveApplyAs(dto)),
						complements_invoice: null,
						...NO_ISSUED,
						credit_note: null,
						cancelled_invoice: null,
						created: {},
						warnings: ['La clave de idempotencia ya estaba registrada: no se modificó nada'],
						warning_codes: [],
						idempotent: true,
					};
				}
			}
			const lines = await this.loadPeriodLines(runner, item.id, holdingId, periodStart, true);
			const existing = await this.loadEntry(runner, item.id, periodStart, true);
			const plan = this.plan(item, lines, existing, periodStart, dto);

			const entry = { ...plan.entry, source };
			let invoice: ConsumptionInvoiceView | null = null;
			let resultLines: ConsumptionLineRow[] = [];
			let creditNote: ConsumptionWriteResult['credit_note'] = null;
			let cancelledInvoice: ConsumptionWriteResult['cancelled_invoice'] = null;
			const created: ConsumptionWriteResult['created'] = {};
			const eventMeta: Record<string, unknown> = {};
			let unified: Awaited<ReturnType<ContractInvoiceConsolidationService['resyncFromOrigins']>> | null = null;

			// 1. Factura: recálculo de la Por Emitir (§4.3), complementaria o reemisión (§4.4). Nunca la emitida.
			if (plan.mode === 'recompute' && plan.target && plan.priced) {
				resultLines = await this.applyRecompute(runner, item, plan, holdingId);
				// Sin cobro revertido: la factura vuelve a Por Emitir ANTES de recalcular el encabezado (que solo toca Por Emitir).
				if (plan.no_charge === 'reverted') {
					await runner.query(
						`UPDATE invoices SET status = '${PENDING_STATUS}' WHERE id = $1 AND holding_id = $2 AND status = '${CANCELLED_STATUS}'`,
						[plan.target.invoice_id, holdingId]
					);
				}
				const header = await this.recomputeHeader(runner, plan.target.invoice_id, holdingId, plan.target.tax_rate, plan.target.fx);

				// Origen consolidado (Domi 05-10): el documento real es el unificado Por Emitir; se vuelven a copiar las líneas de sus orígenes
				// (con la de este ítem ya recalculada) y se recalcula su encabezado, con las mismas reglas que al consolidar.
				if (plan.target.consolidated_pending && plan.target.consolidated_into_invoice_id) {
					unified = await this.consolidation.resyncFromOrigins(runner, holdingId, plan.target.consolidated_into_invoice_id);
					plan.warnings.push(
						`La factura del período está consolidada en ${unified.invoice_number ?? 'un documento unificado'} (Por Emitir): se recalculó también el unificado`
					);
					plan.warning_codes.push(CONSOLIDATED_RESYNC_CODE);
				}

				// Sin cobro: con el encabezado ya en 0, pasa a Cancelada (las líneas en 0 se conservan para poder reactivarla).
				if (plan.no_charge === 'becomes') {
					await runner.query(
						`UPDATE invoices SET status = '${CANCELLED_STATUS}' WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
						[plan.target.invoice_id, holdingId]
					);
				}
				if (plan.no_charge) {
					await runner.query(
						`INSERT INTO contract_lifecycle_events (
							contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
						) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb)`,
						[
							contractId,
							holdingId,
							plan.no_charge === 'becomes' ? INVOICE_EVENT_TYPES.no_charge : INVOICE_EVENT_TYPES.no_charge_reverted,
							plan.no_charge === 'becomes'
								? `Factura ${plan.target.invoice_number ?? plan.target.billing_period_start} sin cobro`
								: `Factura ${plan.target.invoice_number ?? plan.target.billing_period_start} vuelve a Por Emitir`,
							plan.no_charge === 'becomes'
								? `Consumo 0 de "${item.product_name ?? ''}" (${periodStart}): todas las líneas de la factura quedaron en 0; pasa a Cancelada sin cobro`
								: `Consumo ${entry.quantity} de "${item.product_name ?? ''}" (${periodStart}): la factura sin cobro vuelve a Por Emitir`,
							userId ?? SYSTEM_ACTOR_ID,
							plan.target.issue_date,
							JSON.stringify({
								source: 'api_v2',
								invoice_id: plan.target.invoice_id,
								reason: plan.no_charge === 'becomes' ? 'zero_consumption' : 'consumption',
								before: { status: plan.target.status },
								after: {
									status: plan.no_charge === 'becomes' ? CANCELLED_STATUS : PENDING_STATUS,
									amount_contract_currency: header.amount_contract_currency,
								},
								period: { start: plan.target.billing_period_start, end: plan.target.billing_period_end },
								contract_item_id: item.id,
							}),
						]
					);
				}

				invoice = {
					id: plan.target.invoice_id,
					invoice_number: plan.target.invoice_number,
					status: plan.no_charge === 'becomes' ? CANCELLED_STATUS : plan.no_charge === 'reverted' ? PENDING_STATUS : plan.target.status,
					issue_date: plan.target.issue_date,
					currency: plan.target.invoice_currency,
					fx: plan.target.fx,
					subtotal: header.amount_contract_currency,
					tax: header.vat,
					total: header.total_invoice_currency ?? round2(header.amount_contract_currency + header.vat),
				};
			} else if (plan.mode === 'additional' && plan.reference && plan.additional) {
				const header = await this.loadInvoiceHeader(runner, plan.reference.invoice_id, holdingId);
				const draft = this.additionalDraft(item, plan, header, todayFor(await holdingTimezone(this.dataSource, holdingId)));

				addFittedWarning(plan.warnings, plan.warning_codes, draft.fitted_lines, item.description_max_chars);
				const invoiceId = await this.insertInvoiceHeader(runner, header, draft, holdingId);
				// Multimoneda: la línea no toma la tasa del encabezado clonado; queda sin tasa y `pairInvoiceView` le da la de su par.
				const ids = await this.insertLines(
					runner,
					invoiceId,
					header,
					header.multicurrency ? null : draft.fx,
					draft.issue_date,
					draft.newLines,
					holdingId
				);

				resultLines = draft.lines.map((part, index) => ({ ...stripAmounts(part), id: ids[index] ?? null }));
				invoice = await this.pairInvoiceView(runner, header, { ...draft.invoice, id: invoiceId }, holdingId);
				plan.line = this.lineFromRow(plan.priced!, resultLines[0], invoiceId);
				created.invoice_id = invoiceId;
				Object.assign(eventMeta, {
					complements_invoice_id: header.id,
					complements_invoice_number: header.invoice_number,
					complements_invoice_status: header.status,
					...plan.additional,
				});
			} else if (plan.mode === 'reissue' && plan.issued && plan.priced) {
				const header = await this.loadInvoiceHeader(runner, plan.issued.invoice_id, holdingId);
				const issuedLines = await this.loadInvoiceLines(runner, header.id, holdingId);
				const draft = this.reissueDraft(item, plan, header, issuedLines, todayFor(await holdingTimezone(this.dataSource, holdingId)));

				addFittedWarning(plan.warnings, plan.warning_codes, draft.fitted_lines, item.description_max_chars);
				const creditNoteId = await insertMirrorCreditNote(
					runner,
					{ id: header.id, tax_rate: header.tax_rate },
					issuedLines.map((line) => ({
						line,
						ratio: 1,
						period_start: line.billing_period_start ?? line.billing_period_end ?? draft.issue_date,
					})),
					`NC de anulación por consumo corregido de "${item.product_name ?? ''}" (${plan.issued.billing_period_start} a ${plan.issued.billing_period_end}); factura original ${
						header.invoice_number ?? header.id
					}`.replace(/\s+/g, ' '),
					holdingId,
					draft.issue_date,
					{
						credit_reason: 'issue_error',
						credit_type: 'cancellation',
						line_suffix: () => ` (NC espejo por reemisión de ${header.invoice_number ?? header.id})`,
						// Anulación completa: cada línea copia su IVA guardado (la NC cancela la emitida al centavo).
						exact: true,
						reference: {
							kind: 'cancellation',
							reason: `Reemisión por consumo corregido de "${item.product_name ?? ''}"`,
							user_id: userId,
						},
					}
				);
				const invoiceId = await this.insertInvoiceHeader(runner, header, draft, holdingId);
				const ids = await this.insertLines(
					runner,
					invoiceId,
					header,
					header.multicurrency ? null : draft.fx,
					draft.issue_date,
					draft.lines,
					holdingId
				);
				const offset = draft.lines.length - draft.item_lines.length;

				resultLines = draft.item_lines.map((line, index) => ({ ...line, id: ids[offset + index] ?? null }));
				invoice = await this.pairInvoiceView(runner, header, { ...draft.invoice, id: invoiceId }, holdingId);
				creditNote = { id: creditNoteId, number: null, total: draft.credit_note.total };
				cancelledInvoice = { id: header.id, invoice_number: header.invoice_number };
				created.invoice_id = invoiceId;
				created.credit_note_id = creditNoteId;
				Object.assign(eventMeta, {
					cancelled_invoice_id: header.id,
					cancelled_invoice_number: header.invoice_number,
					credit_note_id: creditNoteId,
					credit_note_total: draft.credit_note.total,
					lines_count: draft.lines.length,
				});
			}
			if (plan.additional)
				Object.assign(eventMeta, { additional_amount: plan.additional.difference, already_invoiced: plan.additional.already_invoiced });

			// 2. Entry (con la factura que la lleva) + historial append-only.
			const entryId = await this.writeEntry(
				runner,
				contractId,
				item,
				{ ...entry, invoice_id: invoice?.id ?? null },
				existing,
				source,
				holdingId,
				userId
			);

			if (unified)
				Object.assign(eventMeta, { consolidated_invoice_id: unified.invoice_id, consolidated_invoice_number: unified.invoice_number });

			// 3. Devengo del mes del período: siempre (D2-c, Domi 05-10: un mes con consumo devenga lo facturado del período; sin línea vigente,
			// la regla del consumo), también cuando solo había facturas anuladas.
			await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, date_trunc('month', $2::date)::date)`, [contractId, periodStart]);

			// 4. Evento.
			const previousQuantity = existing?.quantity ?? null;
			const titles: Record<ConsumptionEvent, string> = {
				CONSUMPTION_RECORDED: 'Consumo registrado',
				CONSUMPTION_CORRECTED: 'Consumo corregido',
				CONSUMPTION_ADDITIONAL_INVOICE: 'Consumo adicional facturado',
				CONSUMPTION_REISSUE: 'Factura reemitida por consumo',
			};
			const verbs: Record<ConsumptionEvent, string> = {
				CONSUMPTION_RECORDED: 'Se registró',
				CONSUMPTION_CORRECTED: 'Se corrigió',
				CONSUMPTION_ADDITIONAL_INVOICE: 'Se registró',
				CONSUMPTION_REISSUE: 'Se corrigió',
			};
			const suffix =
				plan.mode === 'recompute' && invoice
					? ` (factura ${invoice.invoice_number ?? invoice.id} recalculada)`
					: plan.mode === 'additional' && invoice && plan.additional && plan.reference
						? ` (complementaria ${invoice.id} por ${plan.reference.contract_currency ?? ''} ${plan.additional.difference} sobre ${
								plan.reference.invoice_number ?? plan.reference.invoice_id
							}${isPendingLine(plan.reference) ? ', Por Emitir' : ''})`
						: plan.mode === 'reissue' && invoice && cancelledInvoice && creditNote
							? ` (${cancelledInvoice.invoice_number ?? cancelledInvoice.id} anulada con NC ${creditNote.id} y reemitida como ${invoice.id})`
							: '';

			await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, items_affected, metadata
				) VALUES ($1, $2, $3, 'Completed', $4, $5, $6, now(), $7::date, $8::jsonb, $9::jsonb)`,
				[
					contractId,
					holdingId,
					plan.event,
					titles[plan.event],
					`${verbs[plan.event]} el consumo de "${item.product_name ?? ''}" del período ${entry.period_start} a ${entry.period_end}: ${
						previousQuantity === null ? '' : `${previousQuantity} → `
					}${entry.quantity}${item.metric?.unit ? ` ${item.metric.unit}` : ''}${suffix}`.replace(/\s+/g, ' '),
					userId ?? SYSTEM_ACTOR_ID,
					entry.period_start,
					JSON.stringify([item.id]),
					JSON.stringify({
						source: 'api_v2',
						entry_source: source,
						entry_id: entryId,
						revision: entry.revision,
						previous_quantity: previousQuantity,
						quantity: entry.quantity,
						amount_override: entry.amount_override,
						reason: entry.correction_reason,
						mode: plan.mode,
						invoice_id: invoice?.id ?? null,
						line_subtotal: plan.priced?.subtotal ?? null,
						line_ids: resultLines.map((line) => line.id),
						no_charge: plan.no_charge,
						...eventMeta,
					}),
				]
			);

			await runner.commitTransaction();

			return {
				entry: { ...entry, id: entryId, invoice_id: invoice?.id ?? null },
				line: plan.line ? { ...plan.line, id: resultLines[0]?.id ?? plan.line.id, invoice_id: invoice?.id ?? plan.line.invoice_id } : null,
				lines: resultLines,
				invoice,
				event: plan.event,
				mode: plan.mode,
				apply_as: plan.apply_as,
				on_issued: onIssuedOf(plan.apply_as),
				complements_invoice: plan.reference ? this.referenceView(plan.reference) : null,
				...plan.outcome,
				credit_note: creditNote,
				cancelled_invoice: cancelledInvoice,
				created,
				warnings: plan.warnings,
				warning_codes: plan.warning_codes,
				idempotent: false,
			};
		} catch (error) {
			await runner.rollbackTransaction();
			if (!(error instanceof HttpException))
				this.logger.warn(`No se pudo registrar el consumo del ítem ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		} finally {
			await runner.release();
		}
	}

	// ---------------------------------------------------------------- escrituras de apoyo

	/** Entry vigente: UPDATE (revisión +1) o INSERT, más su fila en `consumption_entry_revisions`. Devuelve el id. */
	private async writeEntry(
		runner: QueryRunner,
		contractId: string,
		item: MeteredItem,
		entry: Omit<EntryView, 'id'>,
		existing: EntryView | null,
		source: ConsumptionWriteSource,
		holdingId: string,
		userId: string | null
	): Promise<string> {
		let entryId: string;

		if (existing) {
			// UPDATE … RETURNING devuelve [filas, conteo] en TypeORM: el id es el de la entry existente (08-10: "undefined" → 500 al corregir).
			await runner.query(
				`UPDATE consumption_entries SET quantity = $3, amount_override = $4, apply_item_discount = $5, account = $6, is_estimated = $7,
					source = $8, idempotency_key = COALESCE($9, idempotency_key), revision = $10, correction_reason = $11, notes = $12,
					updated_at = now(), updated_by = $13, invoice_id = $14
				WHERE id = $1 AND holding_id = $2 RETURNING id`,
				[
					existing.id,
					holdingId,
					entry.quantity,
					entry.amount_override,
					entry.apply_item_discount,
					entry.account,
					entry.is_estimated,
					source,
					entry.idempotency_key,
					entry.revision,
					entry.correction_reason,
					entry.notes,
					userId,
					entry.invoice_id,
				]
			);
			entryId = String(existing.id);
		} else {
			const [inserted] = (await runner.query(
				`INSERT INTO consumption_entries (
					holding_id, contract_id, contract_item_id, period_start, period_end, quantity, amount_override, apply_item_discount, account,
					is_estimated, source, idempotency_key, revision, correction_reason, notes, created_by, updated_by, invoice_id
				) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, 1, NULL, $13, $14, $14, $15) RETURNING id`,
				[
					holdingId,
					contractId,
					item.id,
					entry.period_start,
					entry.period_end,
					entry.quantity,
					entry.amount_override,
					entry.apply_item_discount,
					entry.account,
					entry.is_estimated,
					source,
					entry.idempotency_key,
					entry.notes,
					userId,
					entry.invoice_id,
				]
			)) as Row[];

			entryId = String(inserted.id);
		}
		// Historial append-only: cada revisión (también la primera) deja su fila.
		await runner.query(
			`INSERT INTO consumption_entry_revisions (holding_id, entry_id, revision, quantity, amount_override, apply_item_discount, source, reason, changed_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				holdingId,
				entryId,
				entry.revision,
				entry.quantity,
				entry.amount_override,
				entry.apply_item_discount,
				source,
				entry.correction_reason,
				userId,
			]
		);

		return entryId;
	}

	/**
	 * Paso 2 de §4.3 sobre las filas del ítem en la Por Emitir: `single` actualiza la fila (y borra sobrantes de un `per_tier`
	 * anterior); `per_tier` borra el conjunto y lo inserta de nuevo (con `contract_item_id` en el INSERT: con la costura
	 * `standardize_invoice_items` y `auto_populate_invoice_item_fields` no corren para la API).
	 */
	private async applyRecompute(runner: QueryRunner, item: MeteredItem, plan: WritePlan, holdingId: string): Promise<ConsumptionLineRow[]> {
		const target = plan.target!;
		const existingIds = plan.target_lines.map((line) => line.line_id);
		const [single] = plan.parts;

		if (single?.id) {
			const amounts = single.amounts;

			await runner.query(
				`UPDATE invoice_items SET quantity = $3, unit_price_contract_currency = $4, unit_price_invoice_currency = $5,
					subtotal_contract_currency = $6, subtotal_invoice_currency = $7, tax_amount_contract_currency = $8, tax_amount_invoice_currency = $9,
					total_contract_currency = $10, total_invoice_currency = $11, pricing_breakdown = $12::jsonb, quantity_source = $13, updated_at = now(),
					-- Una glosa escrita a mano (description_locked, spec facturas §3.6) no se regenera.
					description = CASE WHEN description_locked THEN description ELSE $15 END
				WHERE id = $1 AND holding_id = $2 AND contract_item_id = $14`,
				[
					single.id,
					holdingId,
					amounts.quantity,
					amounts.unit_price_contract_currency,
					amounts.unit_price_invoice_currency,
					amounts.subtotal_contract_currency,
					amounts.subtotal_invoice_currency,
					amounts.tax_amount_contract_currency,
					amounts.tax_amount_invoice_currency,
					amounts.total_contract_currency,
					amounts.total_invoice_currency,
					JSON.stringify(single.pricing_breakdown),
					single.quantity_source,
					item.id,
					single.description,
				]
			);
			const extra = existingIds.filter((id) => id !== single.id);

			if (extra.length) {
				await runner.query(
					`DELETE FROM invoice_items WHERE id = ANY($1::uuid[]) AND invoice_id = $2 AND holding_id = $3 AND contract_item_id = $4`,
					[extra, target.invoice_id, holdingId, item.id]
				);
			}

			return plan.parts.map(stripAmounts);
		}
		if (existingIds.length) {
			await runner.query(
				`DELETE FROM invoice_items WHERE id = ANY($1::uuid[]) AND invoice_id = $2 AND holding_id = $3 AND contract_item_id = $4`,
				[existingIds, target.invoice_id, holdingId, item.id]
			);
		}
		const ids = await this.insertLines(
			runner,
			target.invoice_id,
			{ contract_currency: target.contract_currency, invoice_currency: target.invoice_currency, tax_rate: target.tax_rate },
			target.fx,
			target.issue_date ?? todayFor(await holdingTimezone(this.dataSource, holdingId)),
			plan.parts.map((part) => ({
				contract_item_id: item.id,
				product_id: target.product_id ?? null,
				description: part.description,
				quantity: part.quantity,
				unit_of_measure: target.unit_of_measure ?? item.unit_of_measure,
				discount_pct: target.discount_pct,
				amounts: part.amounts,
				billing_period_start: target.billing_period_start,
				billing_period_end: target.billing_period_end,
				quantity_source: part.quantity_source,
				pricing_breakdown: part.pricing_breakdown,
				description_locked: part.description_locked === true,
			})),
			holdingId
		);

		return plan.parts.map((part, index) => ({ ...stripAmounts(part), id: ids[index] ?? null }));
	}

	/**
	 * Encabezado = Σ líneas (las demás líneas no se tocan) y montos en moneda del sistema (`refreshInvoiceSystemAmounts`, antes
	 * `auto_populate_invoice_fx_to_system`). `sync_invoice_items_on_invoice_update` solo actúa si cambian status/issue_date.
	 */
	private async recomputeHeader(runner: QueryRunner, invoiceId: string, holdingId: string, taxRate: number, fx: number | null) {
		const multicurrency = await this.multicurrencyHeaderOf(runner, invoiceId, holdingId);

		if (multicurrency) {
			await runner.query(
				`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6, tax_rate = $7,
					fx_contract_to_invoice = $8
				WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[
					invoiceId,
					holdingId,
					multicurrency.amount_contract_currency,
					multicurrency.vat,
					multicurrency.amount_invoice_currency,
					multicurrency.total_invoice_currency,
					taxRate,
					multicurrency.fx,
				]
			);
			await refreshInvoiceSystemAmounts(runner, holdingId, [invoiceId]);

			return multicurrency;
		}
		const [sums] = (await runner.query(
			`SELECT COALESCE(SUM(subtotal_contract_currency), 0) AS subtotal, COALESCE(SUM(tax_amount_contract_currency), 0) AS tax
			FROM invoice_items WHERE invoice_id = $1 AND holding_id = $2`,
			[invoiceId, holdingId]
		)) as Row[];
		const header = headerAmounts(toNumber(sums?.subtotal), toNumber(sums?.tax), taxRate, fx);

		// `tax_rate` se reescribe normalizado (0,19 → 19), coherente con el IVA recalculado.
		await runner.query(
			`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6, tax_rate = $7
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
			[
				invoiceId,
				holdingId,
				header.amount_contract_currency,
				header.vat,
				header.amount_invoice_currency,
				header.total_invoice_currency,
				taxRate,
			]
		);
		await refreshInvoiceSystemAmounts(runner, holdingId, [invoiceId]);

		return header;
	}

	/**
	 * Multimoneda: encabezado por par (`multicurrencyHeader`) si la factura tiene líneas en monedas distintas de la de su encabezado; null si no
	 * (el encabezado de siempre). La moneda de contrato convierte cada línea con la tasa pactada ítem → contrato del contrato.
	 */
	private async multicurrencyHeaderOf(runner: QueryRunner, invoiceId: string, holdingId: string) {
		const rows = ((await runner.query(
			`SELECT ii.contract_currency AS line_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency, ii.subtotal_invoice_currency,
				ii.tax_amount_invoice_currency, ii.fx_contract_to_invoice, ii.billing_period_start::text AS billing_period_start,
				i.contract_currency, i.invoice_currency, i.contract_id, i.issue_date::text AS issue_date
			FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
			WHERE ii.invoice_id = $1 AND ii.holding_id = $2
				AND EXISTS (SELECT 1 FROM invoice_items m WHERE m.invoice_id = i.id AND m.contract_currency IS DISTINCT FROM i.contract_currency)`,
			[invoiceId, holdingId]
		)) ?? []) as Row[];

		if (!Array.isArray(rows) || !rows.length) return null;
		const itemRates = ((await runner.query(
			`SELECT from_currency, to_currency, rate, period_start::text AS period_start, period_end::text AS period_end, created_at
			FROM contract_fx_period_rates WHERE contract_id = $1 AND holding_id = $2 AND purpose = 'item'`,
			[rows[0].contract_id, holdingId]
		)) ?? []) as Array<{ from_currency: string; to_currency: string; rate: number; period_start: string; period_end: string }>;

		return multicurrencyHeader(
			rows.map((row) => ({
				currency: toText(row.line_currency),
				subtotal: toNumber(row.subtotal_contract_currency),
				tax: toNumber(row.tax_amount_contract_currency),
				subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
				tax_invoice: toNullableNumber(row.tax_amount_invoice_currency),
				fx: toNullableNumber(row.fx_contract_to_invoice),
				period_start: toText(row.billing_period_start),
			})),
			{
				contract_currency: toText(rows[0].contract_currency) ?? '',
				invoice_currency: toText(rows[0].invoice_currency) ?? '',
				item_rates: itemRates,
				fallback_date: toText(rows[0].issue_date) ?? '',
			}
		);
	}

	/**
	 * Encabezado de una factura nueva del período (complementaria o reemisión, §4.4): clon de la emitida (receptor, emisor,
	 * monedas, condiciones) con fechas de hoy, tipo de documento del contrato, FX según política y montos = Σ líneas. Nace Por
	 * Emitir, `Automatica` (el CHECK de `invoice_type` no admite otro valor: el vínculo va en `notes`, en el evento y en
	 * `consumption_entries.invoice_id`). La API escribe `invoice_group_id = id`, las condiciones (las de la emitida o, si no
	 * tiene, las del contrato) y los montos en moneda del sistema: lo que antes rellenaban triggers.
	 */
	private async insertInvoiceHeader(
		runner: QueryRunner,
		source: IssuedInvoiceHeader,
		draft: {
			fx: number | null;
			issue_date: string;
			due_date: string;
			document_type: string;
			export_type: number;
			notes: string;
			header: ReturnType<typeof headerAmounts>;
		},
		holdingId: string
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id,
				holding_id, contract_id, company_id, client_id, client_entity_id,
				scheduled_at, original_issue_date, issue_date, due_date, status,
				contract_currency, invoice_currency, system_currency,
				amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency, fx_contract_to_invoice,
				invoice_type, document_type, export_type, tax_rate, invoice_series,
				issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id, payment_method, fiscal_regime,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, notes, is_active
			) SELECT
				g.id, g.id,
				$1, $2, $3, $4, $5,
				$6, $6, $6, $7, '${PENDING_STATUS}',
				$8, $9, $10,
				$11, $12, $13, $14, $15,
				'Automatica', $16, $17, $18, $19,
				$20, $21, $22, $23, $24, $25,
				$26, $27, ${invoiceTermsSql(2, 28)}, $29, true
			FROM (SELECT gen_random_uuid() AS id) g
			RETURNING id`,
			[
				holdingId,
				(await this.contractIdOf(runner, source.id, holdingId)) ?? null,
				source.company_id,
				source.client_id,
				source.client_entity_id,
				draft.issue_date,
				draft.due_date,
				source.contract_currency,
				source.invoice_currency,
				source.system_currency,
				draft.header.amount_contract_currency,
				draft.header.amount_invoice_currency,
				draft.header.vat,
				draft.header.total_invoice_currency,
				draft.fx,
				draft.document_type,
				draft.export_type,
				source.tax_rate,
				source.invoice_series ?? 'FAC',
				source.issuer_tax_id,
				source.issuer_legal_name,
				source.issuer_address,
				source.client_tax_id,
				source.payment_method,
				source.fiscal_regime,
				source.requires_references_for_billing,
				source.auto_invoice,
				source.invoice_terms_and_conditions,
				draft.notes,
			]
		)) as Row[];
		const invoiceId = String(row.id);

		await refreshInvoiceSystemAmounts(runner, holdingId, [invoiceId]);

		return invoiceId;
	}

	/**
	 * Multimoneda (spec-multimoneda §4): la factura nueva del período (complementaria o reemisión) de un contrato con el flag se valoriza por
	 * par: cada línea con la moneda de su ítem y la tasa de su par (fija pactada del período o spot → NULL), encabezado = Σ líneas. Devuelve la
	 * vista de la factura con esos montos; sin el flag, la del borrador tal cual.
	 */
	private async pairInvoiceView(
		runner: QueryRunner,
		header: IssuedInvoiceHeader,
		view: ConsumptionInvoiceView,
		holdingId: string
	): Promise<ConsumptionInvoiceView> {
		if (!header.multicurrency) return view;
		const revalued = (await revalueMulticurrencyInvoices(runner, holdingId, [view.id])).get(view.id);

		if (!revalued) return view;

		return {
			...view,
			fx: revalued.header.fx,
			subtotal: revalued.header.amount_contract_currency,
			tax: revalued.header.vat,
			total: revalued.header.total_invoice_currency ?? round2(revalued.header.amount_contract_currency + revalued.header.vat),
		};
	}

	private async contractIdOf(runner: QueryRunner, invoiceId: string, holdingId: string): Promise<string | null> {
		const [row] = (await runner.query(`SELECT contract_id FROM invoices WHERE id = $1 AND holding_id = $2`, [invoiceId, holdingId])) as Row[];

		return toText(row?.contract_id);
	}

	/**
	 * Líneas de una factura con `contract_item_id` en el INSERT (con la costura ya no hace falta el patrón B). `status` e
	 * `issue_date` se copian del encabezado y el producto es el del ítem si lo tiene (lo que hacía
	 * `auto_populate_invoice_item_fields`). Devuelve los ids en orden.
	 */
	private async insertLines(
		runner: QueryRunner,
		invoiceId: string,
		currencies: { contract_currency: string | null; invoice_currency: string | null; tax_rate: number },
		fx: number | null,
		issueDate: string,
		lines: NewLine[],
		holdingId: string
	): Promise<string[]> {
		const contractId = await this.contractIdOf(runner, invoiceId, holdingId);
		const ids: string[] = [];

		for (const line of lines) {
			const [inserted] = (await runner.query(
				`INSERT INTO invoice_items (
					invoice_id, contract_item_id, holding_id, contract_id, product_id, description, quantity, unit_of_measure, discount_pct,
					unit_price_contract_currency, unit_price_invoice_currency, subtotal_contract_currency, subtotal_invoice_currency,
					tax_amount_contract_currency, tax_amount_invoice_currency, total_contract_currency, total_invoice_currency,
					contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date, status, issue_date,
					billing_period_start, billing_period_end, quantity_source, pricing_breakdown, description_locked
				) VALUES (
					$1, $27::uuid, $2, $3, COALESCE((SELECT ci.product_id FROM contract_items ci WHERE ci.id = $27::uuid), $4), $5, $6, $7, $8,
					$9, $10, $11, $12,
					$13, $14, $15, $16,
					$17, $18, $19, $20, $21,
					(SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1),
					$22, $23, $24, $25::jsonb, $26
				) RETURNING id`,
				[
					invoiceId,
					holdingId,
					contractId,
					line.product_id,
					line.description,
					line.quantity,
					line.unit_of_measure?.trim() || 'UND',
					round2(line.discount_pct),
					line.amounts.unit_price_contract_currency,
					line.amounts.unit_price_invoice_currency,
					line.amounts.subtotal_contract_currency,
					line.amounts.subtotal_invoice_currency,
					line.amounts.tax_amount_contract_currency,
					line.amounts.tax_amount_invoice_currency,
					line.amounts.total_contract_currency,
					line.amounts.total_invoice_currency,
					currencies.contract_currency,
					currencies.invoice_currency,
					fx,
					CONSUMPTION_FX_RATE_SOURCE,
					issueDate,
					line.billing_period_start,
					line.billing_period_end,
					line.quantity_source,
					line.pricing_breakdown ? JSON.stringify(line.pricing_breakdown) : null,
					line.description_locked === true,
					line.contract_item_id ?? null,
				]
			)) as Row[];

			ids.push(String(inserted.id));
		}

		return ids;
	}

	// ---------------------------------------------------------------- lectura de apoyo

	/** Ítem del contrato (medido o estándar). El 409 `item_not_metered` ya no vive aquí: lo decide `plan` según la factura del período. */
	/** Bloquea el contrato (`FOR UPDATE`) para serializar escrituras de consumo. Sin chequeo de cierre de períodos (Domi 03-10). */
	private async lockContract(db: Queryable, contractId: string, holdingId: string): Promise<void> {
		await db.query(`SELECT c.id FROM contracts c WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL FOR UPDATE`, [
			contractId,
			holdingId,
		]);
	}

	private async loadMeteredItem(db: Queryable, itemId: string, contractId: string, holdingId: string): Promise<MeteredItem> {
		const [row] = (await db.query(
			`SELECT ci.id, ci.contract_id, ci.product_name, ci.account, ci.quantity, ci.unit_price, ci.unit_of_measure, ci.discount_type, ci.discount_value, ${PRICE_COLUMNS},
				bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit, bm.aggregation AS metric_aggregation,
				c.tax_document_type_id, c.document_type, tdt.description_max_chars AS own_description_max_chars, co.country AS company_country,
				${DESCRIPTION_LIMITS_SQL} AS description_limits
			FROM contract_items ci
			LEFT JOIN prices p ON p.id = ci.price_id
			LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id
			LEFT JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
			LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
			LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
			WHERE ci.id = $1::uuid AND ci.contract_id = $2 AND ci.holding_id = $3`,
			[itemId, contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('El ítem no pertenece al contrato');
		const price = priceSpecFromRow(row);

		return {
			id: String(row.id),
			contract_id: String(row.contract_id),
			product_name: toText(row.product_name),
			account: toText(row.account) || null,
			quantity: toNumber(row.quantity),
			unit_price: toNumber(row.unit_price),
			is_metered: isMetered(price),
			unit_of_measure: toText(row.unit_of_measure),
			discount_type: toText(row.discount_type),
			discount_value: toNullableNumber(row.discount_value),
			price,
			price_summary: priceSummaryFromRow(row),
			metric: row.metric_id
				? {
						id: String(row.metric_id),
						code: toText(row.metric_code) ?? '',
						name: toText(row.metric_name) ?? '',
						unit: toText(row.metric_unit) ?? '',
						aggregation: toText(row.metric_aggregation) ?? '',
					}
				: null,
			description_max_chars: descriptionMaxCharsOfRow(row),
		};
	}

	/** Líneas del ítem cuyo período empieza en `periodStart` (todas las facturas del holding, para clasificar). */
	private async loadPeriodLines(
		db: Queryable,
		itemId: string,
		holdingId: string,
		periodStart: string,
		lock = false
	): Promise<ConsumptionPeriodLine[]> {
		if (!ISO_DATE.test(periodStart)) throw validationException([{ field: 'period_start', message: 'Período inválido (YYYY-MM-DD)' }]);
		const rows = (await db.query(
			`SELECT ii.id AS line_id, ii.invoice_id, ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end,
				ii.discount_pct, ii.quantity, ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.description, ii.product_id, ii.unit_of_measure,
				ii.quantity_source, ii.pricing_breakdown, ii.fx_rate_source, ii.description_locked,
				${noChargeSql('i')} AS no_charge, i.odoo_invoice_id, i.sent_to_odoo_at, ${voidedSql('i')} AS voided,
				i.consolidated_into_invoice_id, ${consolidatedPendingSql('i')} AS consolidated_pending,
				(i.invoice_type = '${UNIFIED_INVOICE_TYPE}' AND ${unifiedV2Sql('i')}) AS unified_v2,
				(SELECT COUNT(*) FROM invoice_items o WHERE o.invoice_id = i.id AND (o.quantity <> 0 OR o.subtotal_contract_currency <> 0)
					AND NOT (o.contract_item_id IS NOT DISTINCT FROM ii.contract_item_id AND o.billing_period_start IS NOT DISTINCT FROM ii.billing_period_start)
				) AS other_nonzero_lines,
				i.invoice_number, i.status, i.is_active, COALESCE(i.is_legacy, false) AS is_legacy, i.invoice_type, i.document_type, i.issue_date::text AS issue_date,
				i.tax_rate,
				-- Multimoneda (spec-multimoneda §4): en un documento con líneas de varias monedas, la línea recalculada conserva SU moneda (la del
				-- ítem) y la tasa de SU par; en los demás, la del encabezado como siempre.
				CASE WHEN EXISTS (SELECT 1 FROM invoice_items m WHERE m.invoice_id = i.id AND m.contract_currency IS DISTINCT FROM i.contract_currency)
					THEN ii.fx_contract_to_invoice ELSE i.fx_contract_to_invoice END AS fx_contract_to_invoice,
				CASE WHEN EXISTS (SELECT 1 FROM invoice_items m WHERE m.invoice_id = i.id AND m.contract_currency IS DISTINCT FROM i.contract_currency)
					THEN COALESCE(ii.contract_currency, i.contract_currency) ELSE i.contract_currency END AS contract_currency,
				i.invoice_currency,
				COALESCE(i.total_invoice_currency, i.amount_contract_currency + COALESCE(i.vat, 0)) AS invoice_total
			FROM invoice_items ii
			JOIN invoices i ON i.id = ii.invoice_id
			WHERE ii.contract_item_id = $1 AND i.holding_id = $2 AND ii.billing_period_start = $3::date
			${lock ? 'FOR UPDATE OF ii, i' : ''}`,
			[itemId, holdingId, periodStart]
		)) as Row[];
		const periodRows: PeriodLine[] = rows.map((row) => ({
			line_id: String(row.line_id),
			invoice_id: String(row.invoice_id),
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			is_active: row.is_active !== false,
			is_legacy: row.is_legacy === true,
			invoice_type: toText(row.invoice_type),
			document_type: toText(row.document_type),
			issue_date: toText(row.issue_date),
			billing_period_start: String(row.billing_period_start).slice(0, 10),
			billing_period_end: String(row.billing_period_end ?? row.billing_period_start).slice(0, 10),
			discount_pct: toNumber(row.discount_pct),
			quantity: toNumber(row.quantity),
			unit_price: toNullableNumber(row.unit_price_contract_currency),
			subtotal: toNumber(row.subtotal_contract_currency),
			// IVA en porcentaje entero (las facturas del front viejo pueden traer 0,19).
			tax_rate: normalizeTaxRate(row.tax_rate as number | string | null) ?? 0,
			fx: toNullableNumber(row.fx_contract_to_invoice),
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			description: toText(row.description),
			product_id: toText(row.product_id),
			unit_of_measure: toText(row.unit_of_measure),
			quantity_source: toText(row.quantity_source),
			pricing_breakdown: (parseJson(row.pricing_breakdown) as PricedSubline[] | null) ?? null,
			fx_rate_source: toText(row.fx_rate_source),
			description_locked: row.description_locked === true,
			no_charge: row.no_charge === true,
			odoo_invoice_id: toNullableNumber(row.odoo_invoice_id),
			sent_to_odoo_at: iso(row.sent_to_odoo_at),
			other_nonzero_lines: toNumber(row.other_nonzero_lines),
			invoice_total: toNullableNumber(row.invoice_total),
			voided: row.voided === true,
			consolidated_into_invoice_id: toText(row.consolidated_into_invoice_id),
			consolidated_pending: row.consolidated_pending === true,
			unified_v2: row.unified_v2 === true,
		}));

		if (periodRows.length) return periodRows;
		// Sin líneas en ese inicio: se listan los períodos del ítem para el mensaje del 409 (solo facturas recalculables).
		const others = (await db.query(
			`SELECT DISTINCT ii.billing_period_start::text AS billing_period_start
			FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
			WHERE ii.contract_item_id = $1 AND i.holding_id = $2 AND i.is_active = true AND COALESCE(i.is_legacy, false) = false
			ORDER BY 1`,
			[itemId, holdingId]
		)) as Row[];

		throw outOfItemConflict(
			periodStart,
			others.map((row) => String(row.billing_period_start).slice(0, 10))
		);
	}

	/** Encabezado de la factura emitida con lo que hace falta del contrato para clonarla (§4.4). */
	private async loadInvoiceHeader(db: Queryable, invoiceId: string, holdingId: string): Promise<IssuedInvoiceHeader> {
		const [row] = (await db.query(
			`SELECT i.id, i.invoice_number, i.status, i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.company_id, i.client_id, i.client_entity_id,
				i.contract_currency, i.invoice_currency, i.system_currency, i.fx_contract_to_invoice, i.tax_rate, i.document_type, i.export_type,
				i.issuer_tax_id, i.issuer_legal_name, i.issuer_address, i.client_tax_id, i.payment_method, i.fiscal_regime, i.invoice_series,
				i.requires_references_for_billing, i.auto_invoice, i.invoice_terms_and_conditions,
				c.document_type AS contract_document_type, c.fx_invoice_policy, c.payment_terms, co.country AS company_country, ce.payment_terms AS entity_payment_terms,
				c.requires_multicurrency_billing
			FROM invoices i
			JOIN contracts c ON c.id = i.contract_id
			LEFT JOIN companies co ON co.id = i.company_id AND co.holding_id = i.holding_id
			LEFT JOIN client_entities ce ON ce.id = i.client_entity_id AND ce.holding_id = i.holding_id
			WHERE i.id = $1 AND i.holding_id = $2`,
			[invoiceId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException(`La factura ${invoiceId} ya no existe`);

		return {
			id: String(row.id),
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			issue_date: toText(row.issue_date),
			due_date: toText(row.due_date),
			company_id: toText(row.company_id),
			client_id: toText(row.client_id),
			client_entity_id: toText(row.client_entity_id),
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			system_currency: toText(row.system_currency),
			fx: toNullableNumber(row.fx_contract_to_invoice),
			// IVA en porcentaje entero (las facturas del front viejo pueden traer 0,19).
			tax_rate: normalizeTaxRate(row.tax_rate as number | string | null) ?? 0,
			document_type: toText(row.document_type),
			export_type: toNullableNumber(row.export_type),
			issuer_tax_id: toText(row.issuer_tax_id),
			issuer_legal_name: toText(row.issuer_legal_name),
			issuer_address: toText(row.issuer_address),
			client_tax_id: toText(row.client_tax_id),
			payment_method: toText(row.payment_method),
			fiscal_regime: toText(row.fiscal_regime),
			invoice_series: toText(row.invoice_series),
			requires_references_for_billing: row.requires_references_for_billing === true,
			auto_invoice: row.auto_invoice === true,
			invoice_terms_and_conditions: toText(row.invoice_terms_and_conditions),
			contract_document_type: toText(row.contract_document_type),
			fx_invoice_policy: toText(row.fx_invoice_policy),
			payment_terms: parseJson(row.payment_terms),
			entity_payment_terms: parseJson(row.entity_payment_terms),
			company_country: toText(row.company_country),
			...(row.requires_multicurrency_billing === true ? { multicurrency: true } : {}),
		};
	}

	/** Todas las líneas de una factura (para la NC espejo y la reemisión). */
	private async loadInvoiceLines(db: Queryable, invoiceId: string, holdingId: string): Promise<IssuedLineRow[]> {
		const rows = (await db.query(
			`SELECT ii.id, ii.invoice_id, ii.contract_item_id, ii.product_id, ii.description, ii.quantity, ii.unit_of_measure,
				ii.unit_price_contract_currency, ii.unit_price_invoice_currency, ii.discount_pct,
				ii.subtotal_contract_currency, ii.subtotal_invoice_currency, ii.tax_amount_contract_currency, ii.tax_amount_invoice_currency,
				ii.total_contract_currency, ii.total_invoice_currency,
				ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end, ii.quantity_source, ii.pricing_breakdown,
				ii.description_locked
			FROM invoice_items ii WHERE ii.invoice_id = $1 AND ii.holding_id = $2
			ORDER BY ii.billing_period_start, ii.id`,
			[invoiceId, holdingId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			invoice_id: String(row.invoice_id),
			contract_item_id: toText(row.contract_item_id),
			product_id: toText(row.product_id),
			description: toText(row.description),
			quantity: toNumber(row.quantity),
			unit_price: toNumber(row.unit_price_contract_currency),
			unit_price_invoice: toNullableNumber(row.unit_price_invoice_currency),
			discount_pct: toNumber(row.discount_pct),
			subtotal: toNumber(row.subtotal_contract_currency),
			subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
			tax_amount: toNumber(row.tax_amount_contract_currency),
			tax_amount_invoice: toNullableNumber(row.tax_amount_invoice_currency),
			total: toNumber(row.total_contract_currency),
			total_invoice: toNullableNumber(row.total_invoice_currency),
			billing_period_start: toText(row.billing_period_start),
			billing_period_end: toText(row.billing_period_end),
			unit_of_measure: toText(row.unit_of_measure),
			quantity_source: toText(row.quantity_source),
			pricing_breakdown: (parseJson(row.pricing_breakdown) as PricedSubline[] | null) ?? null,
			description_locked: row.description_locked === true,
		}));
	}

	private async loadEntry(db: Queryable, itemId: string, periodStart: string, lock = false): Promise<EntryView | null> {
		const [row] = (await db.query(
			`SELECT e.id, e.contract_item_id, e.period_start::text AS period_start, e.period_end::text AS period_end, e.quantity, e.amount_override,
				e.apply_item_discount, e.account, e.is_estimated, e.source, e.revision, e.correction_reason, e.notes, e.idempotency_key, e.invoice_id, e.created_at, e.updated_at
			FROM consumption_entries e WHERE e.contract_item_id = $1 AND e.period_start = $2::date ${lock ? 'FOR UPDATE' : ''}`,
			[itemId, periodStart]
		)) as Row[];

		return row ? this.entryView(row) : null;
	}

	private entryView(row: Row): EntryView {
		return {
			id: String(row.id),
			contract_item_id: String(row.contract_item_id),
			period_start: String(row.period_start).slice(0, 10),
			period_end: String(row.period_end).slice(0, 10),
			quantity: toNumber(row.quantity),
			amount_override: toNullableNumber(row.amount_override),
			apply_item_discount: row.apply_item_discount !== false,
			account: toText(row.account) || null,
			is_estimated: row.is_estimated === true,
			source: toText(row.source) ?? 'manual',
			revision: toNumber(row.revision) || 1,
			correction_reason: toText(row.correction_reason),
			notes: toText(row.notes),
			idempotency_key: toText(row.idempotency_key),
			invoice_id: toText(row.invoice_id),
			created_at: isoDay(row.created_at) ? iso(row.created_at) : null,
			updated_at: isoDay(row.updated_at) ? iso(row.updated_at) : null,
		};
	}
}

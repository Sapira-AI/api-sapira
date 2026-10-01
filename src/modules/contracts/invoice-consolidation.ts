import { round2 } from './billing-engine';
import { isCreditNote, PENDING_STATUS } from './contract-360';
import {
	type ContractInvoiceContext,
	type ContractInvoiceRow,
	erpDraftBlocker,
	type InvoiceBlocker,
	type InvoiceWarning,
	periodClosedBlocker,
} from './contract-invoices';
import { isUnifiedType } from './invoice-consolidation-read';
import { DESCRIPTION_FITTED_CODE, fitDescription, referenceKind } from './invoice-description';
import { MULTICURRENCY_CODES, pairKey, upperCode } from './multicurrency';

/**
 * Consolidación opcional entre contratos (caso socio, `docs/v2-rediseno/spec-multimoneda-contrato.md` §7) y lectura del historial
 * unificado (§9): lógica pura, sin base. El servicio (`contract-invoice-consolidation.service.ts`) carga, bloquea y escribe.
 *
 * Un documento consolidado junta Por Emitir de **≥ 2 contratos** con la misma razón social receptora, compañía emisora, moneda de factura,
 * mes de emisión, documento, `export_type` y serie (los clientes comerciales pueden diferir). Reutiliza `invoice_type = 'Unificada'`,
 * `invoice_group_id` y `consolidated_into_invoice_id`; lo distingue del legacy el evento `INVOICE_CONSOLIDATED`.
 */

export const CONSOLIDATED_INVOICE_TYPE = 'Unificada';
export const CONSOLIDATION_MIN_INVOICES = 2;
export const CONSOLIDATION_MAX_INVOICES = 50;
export const CONSOLIDATION_NOTES_MAX = 500;
/** Separador del prefijo de contrato en la glosa (guion ASCII, regla del DTE). */
export const CONSOLIDATION_PREFIX_SEPARATOR = ' - ';
export const LEGACY_UNIFIED_STEP = 'Los documentos unificados históricos se editan o deshacen en la app actual (Facturación) hasta el switch';

/** Códigos de bloqueo de la consolidación (409 `blocked`). */
export const CONSOLIDATION_BLOCKERS = {
	credit_note: 'credit_note',
	not_pending: 'not_pending',
	already_consolidated: 'already_consolidated',
	legacy_invoice: 'legacy_invoice',
	no_contract: 'no_contract',
	partial_billing_invoice: 'partial_billing_invoice',
	open_consumption: 'open_consumption',
	sent_to_erp_draft: 'sent_to_erp_draft',
	period_closed: 'period_closed',
	single_contract: 'single_contract',
	company_mismatch: 'company_mismatch',
	entity_mismatch: 'entity_mismatch',
	currency_mismatch: 'currency_mismatch',
	month_mismatch: 'month_mismatch',
	document_type_mismatch: 'document_type_mismatch',
	export_type_mismatch: 'export_type_mismatch',
	series_mismatch: 'series_mismatch',
	tax_rate_mismatch: 'tax_rate_mismatch',
	spot_send_pending: MULTICURRENCY_CODES.multicurrency_spot_send_pending,
	// Deshacer
	not_consolidated: 'not_consolidated',
	legacy_unified: 'legacy_unified',
	no_origins: 'no_origins',
} as const;

/** Códigos de aviso (no bloquean). */
export const CONSOLIDATION_WARNINGS = {
	auto_invoice_differs: 'auto_invoice_differs',
	auto_send_to_erp_differs: 'auto_send_to_erp_differs',
	pair_rates_differ: 'pair_rates_differ',
	spot_document: 'spot_document',
	references_inherited: 'references_inherited',
	description_fitted: DESCRIPTION_FITTED_CODE,
} as const;

// ------------------------------------------------------------------ tipos

/** Una factura de origen (o candidata) con lo que necesitan las reglas. */
export interface ConsolidationInvoice {
	id: string;
	invoice_number: string | null;
	contract_id: string | null;
	contract_number: string | null;
	client_id: string | null;
	client_name: string | null;
	status: string | null;
	document_type: string | null;
	invoice_type: string | null;
	is_active: boolean;
	is_legacy: boolean;
	consolidated_into_invoice_id: string | null;
	company_id: string | null;
	client_entity_id: string | null;
	legal_name: string | null;
	invoice_currency: string | null;
	contract_currency: string | null;
	issue_date: string | null;
	scheduled_at: string | null;
	due_date: string | null;
	export_type: number;
	invoice_series: string | null;
	tax_rate: number | null;
	amount_contract_currency: number | null;
	vat: number | null;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
	amount_system_currency: number | null;
	total_system_currency: number | null;
	odoo_invoice_id: number | null;
	sent_to_odoo_at: string | null;
	auto_invoice: boolean;
	requires_references: boolean;
	/** `contracts.requires_references_for_billing` del contrato de la factura. */
	contract_requires_references: boolean;
	/** `contracts.auto_send_to_odoo` (NULL = sí, como el scheduler). */
	contract_auto_send_to_erp: boolean;
	lines_count: number;
	/** Líneas internas (facturada por OC, §3.7b). */
	internal_lines: number;
	/** Líneas por consumo sin cerrar (`quantity_source` pending/estimated). */
	open_lines: number;
	/** Cierre de períodos de la compañía (`get_cutoff_date`), o null. */
	cutoff_date: string | null;
}

/** Línea guardada de una factura de origen (montos `*_contract_currency` en la moneda de la línea = la del ítem). */
export interface ConsolidationLine {
	id: string;
	invoice_id: string;
	/** `invoice_items.contract_id` (o el del ítem si falta). */
	contract_id: string | null;
	contract_item_id: string | null;
	description: string;
	product_name: string | null;
	/** `invoice_items.contract_currency` (moneda de la línea); null = la del encabezado de su factura. */
	currency: string | null;
	quantity: number;
	unit_price: number;
	subtotal: number;
	tax: number;
	total: number;
	unit_price_invoice: number | null;
	subtotal_invoice: number | null;
	tax_invoice: number | null;
	total_invoice: number | null;
	fx: number | null;
	fx_rate_source: string | null;
	fx_rate_date: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
}

/** Referencia OC/HES de un origen: propia (`invoice_references`) o del contrato vinculada (`invoice_reference_links` → `billing_references`). */
export interface ConsolidationReference {
	id: string;
	source: 'invoice' | 'contract';
	invoice_id: string;
	type: string;
	name: string | null;
	code: string;
}

export interface ConsolidationContext {
	invoices: ConsolidationInvoice[];
	lines: ConsolidationLine[];
	references: ConsolidationReference[];
	/** Límite de la glosa por contrato (`resolveDescriptionMaxChars`); se usa el del contrato principal. */
	max_chars_by_contract: Map<string, number | null>;
}

export interface ConsolidationContribution {
	contract_id: string;
	contract_number: string | null;
	client_id: string | null;
	client_name: string | null;
	invoice_ids: string[];
	lines_count: number;
	contract_currency: string | null;
	/** Σ `amount_contract_currency` de sus facturas de origen (en la moneda de SU contrato). */
	amount_contract_currency: number;
	/** Subtotal de sus líneas en moneda de factura en el consolidado; null si alguna queda spot. */
	subtotal_invoice_currency: number | null;
	/** Subtotal por moneda de línea (lo pactado), para mostrar el aporte cuando el documento es spot. */
	subtotal_by_currency: Array<{ currency: string; subtotal: number }>;
	/** Peso para elegir el principal: Σ subtotal en moneda de factura (o de la línea si aún no se valoriza). */
	weight: number;
	main: boolean;
}

export interface ConsolidatedLine {
	source_line_id: string;
	source_invoice_id: string;
	contract_id: string | null;
	contract_number: string | null;
	contract_item_id: string | null;
	description_before: string;
	description: string;
	description_fitted: boolean;
	currency: string;
	quantity: number;
	subtotal: number;
	fx: number | null;
	fx_rate_source: string | null;
	fx_rate_date: string | null;
	unit_price_invoice_currency: number | null;
	subtotal_invoice_currency: number | null;
	tax_invoice_currency: number | null;
	total_invoice_currency: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	/** La línea tenía tasa fija pero el documento queda spot (otra línea es spot): se valoriza al emitir. */
	spot_propagated: boolean;
}

export interface ConsolidatedHeader {
	contract_id: string | null;
	client_id: string | null;
	client_entity_id: string | null;
	company_id: string | null;
	/** Factura del contrato principal de la que se copian emisor, condiciones, forma de pago y serie. */
	template_invoice_id: string | null;
	document_type: string | null;
	export_type: number;
	invoice_series: string | null;
	tax_rate: number | null;
	scheduled_at: string | null;
	issue_date: string | null;
	due_date: string | null;
	invoice_currency: string | null;
	contract_currency: string | null;
	/** `same` = todos los orígenes comparten moneda de contrato; `mixed` = el encabezado queda en moneda de factura. */
	contract_currency_mode: 'same' | 'mixed';
	amount_contract_currency: number | null;
	vat: number | null;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
	fx_contract_to_invoice: number | null;
	/** Solo en modo `mixed`: Σ de los orígenes (en `same` se recalcula con `refreshInvoiceSystemAmounts`). */
	amount_system_currency: number | null;
	total_system_currency: number | null;
	spot: boolean;
	pairs: string[];
	auto_invoice: boolean;
	auto_send_to_erp: boolean;
	requires_references_for_billing: boolean;
}

export interface ConsolidationInvoiceView {
	id: string;
	invoice_number: string | null;
	contract_id: string | null;
	contract_number: string | null;
	client_id: string | null;
	client_name: string | null;
	issue_date: string | null;
	invoice_series: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	amount_contract_currency: number | null;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
	lines_count: number;
	auto_invoice: boolean;
	blockers: InvoiceBlocker[];
}

export interface ConsolidationPlan {
	invoices: ConsolidationInvoiceView[];
	contributions: ConsolidationContribution[];
	main_contract_id: string | null;
	header: ConsolidatedHeader;
	lines: ConsolidatedLine[];
	references: {
		invoice_reference_ids: string[];
		contract_reference_ids: string[];
		items: Array<{ kind: string; code: string; source: 'invoice' | 'contract' }>;
		deduped: number;
	};
	warnings: InvoiceWarning[];
	blockers: InvoiceBlocker[];
	can_apply: boolean;
}

// ------------------------------------------------------------------ elegibilidad

const monthOf = (invoice: Pick<ConsolidationInvoice, 'issue_date' | 'scheduled_at'>) =>
	(invoice.issue_date ?? invoice.scheduled_at ?? '').slice(0, 7);
const docOf = (invoice: Pick<ConsolidationInvoice, 'document_type'>) => invoice.document_type || 'FACTURA';
const label = (invoice: Pick<ConsolidationInvoice, 'invoice_number' | 'id'>) => invoice.invoice_number ?? invoice.id;

/** Bloqueos propios de UNA factura (no dependen de las demás): Por Emitir activa, no NC/ND, no consolidada, no legacy, no OC, ERP, período. */
export function invoiceBlockers(invoice: ConsolidationInvoice): InvoiceBlocker[] {
	const blockers: InvoiceBlocker[] = [];
	const name = label(invoice);

	if (isCreditNote(invoice.document_type) || invoice.document_type === 'ND') {
		return [
			{
				code: CONSOLIDATION_BLOCKERS.credit_note,
				message: `${name} es una nota de crédito o débito: no se consolida`,
				next_step: null,
			},
		];
	}
	if (invoice.status !== PENDING_STATUS || !invoice.is_active) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.not_pending,
			message: `La factura ${name} no está Por Emitir (estado: ${invoice.status ?? 'sin estado'}${invoice.is_active ? '' : ', inactiva'})`,
			next_step: null,
		});
	}
	if (invoice.consolidated_into_invoice_id || isUnifiedType(invoice.invoice_type)) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.already_consolidated,
			message: `La factura ${name} ya es o forma parte de un documento consolidado o unificado`,
			next_step: 'Deshaz la consolidación anterior antes de volver a consolidar',
		});
	}
	if (invoice.is_legacy) {
		blockers.push({ code: CONSOLIDATION_BLOCKERS.legacy_invoice, message: `La factura ${name} es importada (legacy)`, next_step: null });
	}
	if (!invoice.contract_id) {
		blockers.push({ code: CONSOLIDATION_BLOCKERS.no_contract, message: `La factura ${name} no pertenece a un contrato`, next_step: null });
	}
	if (invoice.internal_lines > 0) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.partial_billing_invoice,
			message: `La factura ${name} se factura por OC (línea visible con líneas internas): su documento queda fijo`,
			next_step: null,
		});
	}
	if (invoice.open_lines > 0) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.open_consumption,
			message: `La factura ${name} tiene ${invoice.open_lines} ${invoice.open_lines === 1 ? 'línea' : 'líneas'} por consumo sin cerrar: el consumo recalcularía la factura de origen, no el consolidado`,
			next_step: 'Registra el consumo del período antes de consolidar',
		});
	}
	const erp = erpBlocker(invoice);

	if (erp) blockers.push(erp);
	const closed = periodClosedBlocker(invoice.issue_date, { cutoff_date: invoice.cutoff_date } as ContractInvoiceContext, `La emisión de ${name}`);

	if (closed) blockers.push(closed);

	return blockers;
}

/** Borrador en el ERP (`odoo_invoice_id` o `sent_to_odoo_at`): `sent_to_erp_draft` con `action: 'erp_reset'` (mismo bloqueo del 360). */
export function erpBlocker(
	invoice: Pick<ConsolidationInvoice, 'odoo_invoice_id' | 'sent_to_odoo_at' | 'invoice_number' | 'id'>
): InvoiceBlocker | null {
	if (invoice.odoo_invoice_id !== null)
		return erpDraftBlocker({ odoo_invoice_id: invoice.odoo_invoice_id, sent_to_odoo_at: invoice.sent_to_odoo_at } as ContractInvoiceRow);
	if (!invoice.sent_to_odoo_at) return null;

	return {
		code: CONSOLIDATION_BLOCKERS.sent_to_erp_draft,
		message: `La factura ${label(invoice)} ya se envió al ERP (${invoice.sent_to_odoo_at.slice(0, 10)})`,
		next_step: 'Restablece el borrador del ERP (y elimínalo en el ERP) antes de cambiarla',
		action: 'erp_reset',
	};
}

/** ¿`other` calza con `base` en lo que exige un mismo documento? Devuelve los bloqueos de la pareja (vacío = calza). */
export function pairBlockers(base: ConsolidationInvoice, other: ConsolidationInvoice): InvoiceBlocker[] {
	const blockers: InvoiceBlocker[] = [];
	const name = label(other);
	const push = (code: string, message: string, nextStep: string | null = null) => blockers.push({ code, message, next_step: nextStep });

	if ((base.company_id ?? '') !== (other.company_id ?? '')) push(CONSOLIDATION_BLOCKERS.company_mismatch, `${name} la emite otra compañía`);
	if ((base.client_entity_id ?? '') !== (other.client_entity_id ?? ''))
		push(CONSOLIDATION_BLOCKERS.entity_mismatch, `${name} tiene otra razón social receptora`);
	if (upperCode(base.invoice_currency) !== upperCode(other.invoice_currency))
		push(CONSOLIDATION_BLOCKERS.currency_mismatch, `${name} se factura en ${upperCode(other.invoice_currency) || 'otra moneda'}`);
	if (monthOf(base) !== monthOf(other))
		push(CONSOLIDATION_BLOCKERS.month_mismatch, `${name} se emite en otro mes (${monthOf(other) || 'sin fecha'})`);
	if (docOf(base) !== docOf(other)) push(CONSOLIDATION_BLOCKERS.document_type_mismatch, `${name} es otro tipo de documento (${docOf(other)})`);
	if (base.export_type !== other.export_type)
		push(CONSOLIDATION_BLOCKERS.export_type_mismatch, `${name} tiene otro tipo de exportación (${other.export_type})`);
	if ((base.invoice_series ?? '') !== (other.invoice_series ?? ''))
		push(
			CONSOLIDATION_BLOCKERS.series_mismatch,
			`${name} usa la serie ${other.invoice_series ?? 'sin serie'} (la base usa ${base.invoice_series ?? 'sin serie'})`,
			'Alinea la serie de las facturas antes de consolidar'
		);

	return blockers;
}

/** Bloqueos del grupo: cada factura, cada pareja contra la primera, ≥ 2 contratos y una sola tasa de IVA. */
export function groupBlockers(invoices: ConsolidationInvoice[]): InvoiceBlocker[] {
	const blockers = invoices.flatMap((invoice) => invoiceBlockers(invoice));
	const [base, ...others] = invoices;

	if (base) for (const other of others) blockers.push(...pairBlockers(base, other));
	const contracts = new Set(invoices.map((invoice) => invoice.contract_id).filter(Boolean));

	if (contracts.size < 2) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.single_contract,
			message: 'Las facturas son de un solo contrato: la consolidación junta documentos de 2 o más contratos',
			next_step: 'Para juntar facturas de un mismo contrato usa Reorganizar el cronograma',
		});
	}
	const rates = new Set(invoices.map((invoice) => invoice.tax_rate).filter((rate) => rate !== null));

	if (rates.size > 1) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.tax_rate_mismatch,
			message: `Las facturas tienen tasas de IVA distintas (${[...rates].join(', ')}): un documento lleva una sola`,
			next_step: null,
		});
	}

	return dedupeBlockers(blockers);
}

const dedupeBlockers = (blockers: InvoiceBlocker[]) => {
	const seen = new Set<string>();

	return blockers.filter((blocker) => {
		const key = `${blocker.code}|${blocker.message}`;

		if (seen.has(key)) return false;
		seen.add(key);

		return true;
	});
};

// ------------------------------------------------------------------ glosa, referencias y valorización

/** `CTR-2026-12 - <glosa>` ajustada al límite del documento con `fitDescription` (recorta la glosa, conserva el número). No duplica el prefijo. */
export function prefixDescription(contractNumber: string | null, description: string, maxChars: number | null): { text: string; fitted: boolean } {
	const glosa = (description ?? '').trim();
	const prefix = (contractNumber ?? '').trim();

	if (!prefix) return { text: glosa, fitted: false };
	const body = glosa.startsWith(`${prefix}${CONSOLIDATION_PREFIX_SEPARATOR}`)
		? glosa.slice(prefix.length + CONSOLIDATION_PREFIX_SEPARATOR.length)
		: glosa;
	const fitted = fitDescription(
		{
			separator: CONSOLIDATION_PREFIX_SEPARATOR,
			blocks: [{ type: 'contract_number' }, ...(body ? [{ type: 'text' as const, text: body }] : [])],
		},
		{ line_kind: 'standard', contract_number: prefix },
		maxChars
	);

	return { text: fitted.text, fitted: fitted.fitted };
}

/** Tipo+folio de una referencia: OC (801 / PO), HES u otro nombre; folio sin espacios y en mayúsculas. */
export const referenceKey = (reference: Pick<ConsolidationReference, 'source' | 'type' | 'name' | 'code'>) => {
	const kind =
		reference.source === 'contract'
			? upperCode(reference.type) === 'PO'
				? 'OC'
				: upperCode(reference.type)
			: upperCode(referenceKind(reference.type, reference.name));

	return { kind, key: `${kind}|${upperCode(reference.code)}` };
};

/** Referencias de los orígenes sin repetir tipo+folio (gana la propia de la factura sobre la del contrato, luego la primera). */
export function dedupeReferences(references: ConsolidationReference[]): ConsolidationPlan['references'] {
	const ordered = [...references].sort((a, b) => Number(a.source === 'contract') - Number(b.source === 'contract'));
	const seen = new Set<string>();
	const kept: ConsolidationReference[] = [];
	const items: ConsolidationPlan['references']['items'] = [];

	for (const reference of ordered) {
		if (!reference.code?.trim()) continue;
		const { kind, key } = referenceKey(reference);

		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(reference);
		items.push({ kind, code: reference.code.trim(), source: reference.source });
	}

	return {
		invoice_reference_ids: kept.filter((reference) => reference.source === 'invoice').map((reference) => reference.id),
		contract_reference_ids: [...new Set(kept.filter((reference) => reference.source === 'contract').map((reference) => reference.id))],
		items,
		deduped: references.filter((reference) => reference.code?.trim()).length - kept.length,
	};
}

/**
 * Valorización por par antes de juntar (§7): cada línea conserva su moneda, su tasa y sus montos en moneda de factura; la línea en la moneda
 * de factura queda con FX 1. Si **alguna** línea que convierte es spot (sin tasa o sin montos), el documento queda spot entero: toda línea que
 * convierte pierde tasa y montos en moneda de factura (nunca un documento mixto). Devuelve las líneas y si el documento quedó spot.
 */
export function valueLinesForConsolidation(
	lines: Array<ConsolidationLine & { origin_currency: string | null }>,
	invoiceCurrency: string
): {
	lines: Array<Omit<ConsolidatedLine, 'contract_number' | 'description_before' | 'description' | 'description_fitted'>>;
	spot: boolean;
	pairs: string[];
} {
	const target = upperCode(invoiceCurrency);
	const currencyOf = (line: (typeof lines)[number]) => upperCode(line.currency) || upperCode(line.origin_currency) || target;
	const converting = (line: (typeof lines)[number]) => currencyOf(line) !== target;
	const isSpot = (line: (typeof lines)[number]) => converting(line) && (line.fx === null || line.subtotal_invoice === null);
	const spot = lines.some(isSpot);
	const pairs = [...new Set(lines.filter(converting).map((line) => pairKey(currencyOf(line), target)))];

	return {
		spot,
		pairs,
		lines: lines.map((line) => {
			const currency = currencyOf(line);
			const base = {
				source_line_id: line.id,
				source_invoice_id: line.invoice_id,
				contract_id: line.contract_id,
				contract_item_id: line.contract_item_id,
				currency,
				quantity: line.quantity,
				subtotal: line.subtotal,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
			};

			if (!converting(line)) {
				return {
					...base,
					fx: 1,
					fx_rate_source: line.fx_rate_source,
					fx_rate_date: line.fx_rate_date,
					unit_price_invoice_currency: line.unit_price_invoice ?? line.unit_price,
					subtotal_invoice_currency: line.subtotal_invoice ?? line.subtotal,
					tax_invoice_currency: line.tax_invoice ?? line.tax,
					total_invoice_currency: line.total_invoice ?? line.total,
					spot_propagated: false,
				};
			}
			if (spot) {
				return {
					...base,
					fx: null,
					fx_rate_source: null,
					fx_rate_date: null,
					unit_price_invoice_currency: null,
					subtotal_invoice_currency: null,
					tax_invoice_currency: null,
					total_invoice_currency: null,
					spot_propagated: !isSpot(line),
				};
			}

			return {
				...base,
				fx: line.fx,
				fx_rate_source: line.fx_rate_source,
				fx_rate_date: line.fx_rate_date,
				unit_price_invoice_currency: line.unit_price_invoice,
				subtotal_invoice_currency: line.subtotal_invoice,
				tax_invoice_currency: line.tax_invoice,
				total_invoice_currency: line.total_invoice,
				spot_propagated: false,
			};
		}),
	};
}

/** Contrato principal: el de mayor aporte; empate → número de contrato menor (como la legacy). */
export function mainContractOf(contributions: Array<Pick<ConsolidationContribution, 'contract_id' | 'contract_number' | 'weight'>>): string | null {
	const sorted = [...contributions].sort(
		(a, b) => b.weight - a.weight || (a.contract_number ?? a.contract_id).localeCompare(b.contract_number ?? b.contract_id)
	);

	return sorted[0]?.contract_id ?? null;
}

/** Montos de contrato del VAT de una factura (spot): el propio si no estaba valorizada; si lo estaba, convertido con su tasa efectiva. */
const vatInContractCurrency = (invoice: ConsolidationInvoice) => {
	const vat = invoice.vat ?? 0;

	if (invoice.amount_invoice_currency === null) return vat;
	if (!invoice.amount_invoice_currency || invoice.amount_contract_currency === null) return vat;

	return round2((vat * invoice.amount_contract_currency) / invoice.amount_invoice_currency);
};

const sumOrNull = (values: Array<number | null>) =>
	values.some((value) => value === null) ? null : round2(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));

// ------------------------------------------------------------------ plan

/** Plan de la consolidación (preview y aplicar comparten el cálculo). `invoices` en el orden pedido. */
export function planConsolidation(ctx: ConsolidationContext): ConsolidationPlan {
	const { invoices } = ctx;
	const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
	const blockers = groupBlockers(invoices);
	const warnings: InvoiceWarning[] = [];
	const invoiceCurrency = upperCode(invoices[0]?.invoice_currency);
	const lines = ctx.lines
		.filter((line) => byId.has(line.invoice_id))
		.map((line) => {
			const origin = byId.get(line.invoice_id)!;

			return { ...line, contract_id: line.contract_id ?? origin.contract_id, origin_currency: origin.contract_currency };
		});
	const valued = valueLinesForConsolidation(lines, invoiceCurrency);

	// ---- aporte por contrato y principal
	const contractIds = [...new Set(invoices.map((invoice) => invoice.contract_id).filter((id): id is string => !!id))];
	const contributions: ConsolidationContribution[] = contractIds.map((contractId) => {
		const own = invoices.filter((invoice) => invoice.contract_id === contractId);
		const ownIds = new Set(own.map((invoice) => invoice.id));
		const ownLines = valued.lines.filter((line) => ownIds.has(line.source_invoice_id));
		const sourceLines = lines.filter((line) => ownIds.has(line.invoice_id));
		const byCurrency = new Map<string, number>();

		for (const line of ownLines) byCurrency.set(line.currency, round2((byCurrency.get(line.currency) ?? 0) + line.subtotal));

		return {
			contract_id: contractId,
			contract_number: own[0].contract_number,
			client_id: own[0].client_id,
			client_name: own[0].client_name,
			invoice_ids: own.map((invoice) => invoice.id),
			lines_count: ownLines.length,
			contract_currency: upperCode(own[0].contract_currency) || null,
			amount_contract_currency: round2(own.reduce((sum, invoice) => sum + (invoice.amount_contract_currency ?? 0), 0)),
			subtotal_invoice_currency: sumOrNull(ownLines.map((line) => line.subtotal_invoice_currency)),
			subtotal_by_currency: [...byCurrency.entries()].map(([currency, subtotal]) => ({ currency, subtotal })),
			weight: round2(sourceLines.reduce((sum, line) => sum + (line.subtotal_invoice ?? line.subtotal), 0)),
			main: false,
		};
	});
	const mainContractId = mainContractOf(contributions);

	for (const contribution of contributions) contribution.main = contribution.contract_id === mainContractId;
	const ordered = [...contributions].sort(
		(a, b) => Number(b.main) - Number(a.main) || (a.contract_number ?? a.contract_id).localeCompare(b.contract_number ?? b.contract_id)
	);
	const numberOf = new Map(contributions.map((contribution) => [contribution.contract_id, contribution.contract_number]));
	const template =
		invoices
			.filter((invoice) => invoice.contract_id === mainContractId)
			.sort((a, b) => (a.issue_date ?? '').localeCompare(b.issue_date ?? ''))[0] ?? invoices[0];

	// ---- líneas: prefijo de contrato, ordenadas por contrato (principal primero) y período
	const maxChars = mainContractId ? (ctx.max_chars_by_contract.get(mainContractId) ?? null) : null;
	const rank = new Map(ordered.map((contribution, index) => [contribution.contract_id, index]));
	const sourceById = new Map(lines.map((line) => [line.id, line]));
	let fittedCount = 0;
	const consolidatedLines: ConsolidatedLine[] = valued.lines
		.map((line, index) => ({ line, index }))
		.sort(
			(a, b) =>
				(rank.get(a.line.contract_id ?? '') ?? 99) - (rank.get(b.line.contract_id ?? '') ?? 99) ||
				(a.line.billing_period_start ?? '').localeCompare(b.line.billing_period_start ?? '') ||
				a.index - b.index
		)
		.map(({ line }) => {
			const before = sourceById.get(line.source_line_id)?.description ?? '';
			const contractNumber = line.contract_id ? (numberOf.get(line.contract_id) ?? null) : null;
			const prefixed = prefixDescription(contractNumber, before, maxChars);

			if (prefixed.fitted) fittedCount++;

			return {
				...line,
				contract_number: contractNumber,
				description_before: before,
				description: prefixed.text,
				description_fitted: prefixed.fitted,
			};
		});

	// ---- encabezado = Σ líneas (convención `multicurrencyHeader`)
	const allValued = consolidatedLines.every((line) => line.subtotal_invoice_currency !== null);
	const amountInvoice = allValued ? round2(consolidatedLines.reduce((sum, line) => sum + (line.subtotal_invoice_currency ?? 0), 0)) : null;
	const taxInvoice = allValued ? round2(consolidatedLines.reduce((sum, line) => sum + (line.tax_invoice_currency ?? 0), 0)) : null;
	const converting = consolidatedLines.filter((line) => line.currency !== invoiceCurrency);
	const rates = [...new Set(converting.map((line) => line.fx))];
	const fx = valued.pairs.length === 0 ? 1 : valued.pairs.length === 1 && rates.length === 1 ? rates[0] : null;
	const contractCurrencies = new Set(invoices.map((invoice) => upperCode(invoice.contract_currency) || invoiceCurrency));
	const same = contractCurrencies.size <= 1;
	const contractCurrency = same ? ([...contractCurrencies][0] ?? invoiceCurrency) : invoiceCurrency;
	const amountContract = same ? round2(invoices.reduce((sum, invoice) => sum + (invoice.amount_contract_currency ?? 0), 0)) : amountInvoice;
	const vat = allValued ? taxInvoice : same ? round2(invoices.reduce((sum, invoice) => sum + vatInContractCurrency(invoice), 0)) : null;
	const autoInvoice = invoices.every((invoice) => invoice.auto_invoice);
	const autoSend = invoices.every((invoice) => invoice.contract_auto_send_to_erp);
	const requiresReferences = invoices.some((invoice) => invoice.requires_references || invoice.contract_requires_references);
	const dates = (pick: (invoice: ConsolidationInvoice) => string | null) =>
		invoices
			.map(pick)
			.filter((value): value is string => !!value)
			.sort();
	const header: ConsolidatedHeader = {
		contract_id: mainContractId,
		client_id: template?.client_id ?? null,
		client_entity_id: template?.client_entity_id ?? null,
		company_id: template?.company_id ?? null,
		template_invoice_id: template?.id ?? null,
		document_type: template?.document_type ?? null,
		export_type: template?.export_type ?? 0,
		invoice_series: template?.invoice_series ?? null,
		tax_rate: template?.tax_rate ?? null,
		scheduled_at: dates((invoice) => invoice.scheduled_at ?? invoice.issue_date)[0] ?? null,
		issue_date: dates((invoice) => invoice.issue_date ?? invoice.scheduled_at)[0] ?? null,
		due_date: dates((invoice) => invoice.due_date).slice(-1)[0] ?? null,
		invoice_currency: invoiceCurrency || null,
		contract_currency: contractCurrency || null,
		contract_currency_mode: same ? 'same' : 'mixed',
		amount_contract_currency: amountContract,
		vat,
		amount_invoice_currency: amountInvoice,
		total_invoice_currency: amountInvoice === null || taxInvoice === null ? null : round2(amountInvoice + taxInvoice),
		fx_contract_to_invoice: fx,
		amount_system_currency: same ? null : sumOrNull(invoices.map((invoice) => invoice.amount_system_currency)),
		total_system_currency: same ? null : sumOrNull(invoices.map((invoice) => invoice.total_system_currency)),
		spot: valued.spot,
		pairs: valued.pairs,
		auto_invoice: autoInvoice,
		auto_send_to_erp: autoSend,
		requires_references_for_billing: requiresReferences,
	};

	// ---- spot con más de un par o un par que no es el del encabezado: el envío por par es de Leon (MM4)
	if (valued.spot && (valued.pairs.length > 1 || valued.pairs.some((pair) => pair.split('>')[0] !== contractCurrency))) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.spot_send_pending,
			message: `El documento quedaría spot con ${valued.pairs.join(', ')}: el envío al ERP aún valoriza una sola tasa por documento (moneda del contrato → factura)`,
			next_step: 'Fija el tipo de cambio de las facturas de origen (FX por factura) antes de consolidar',
		});
	}

	// ---- avisos
	if (new Set(invoices.map((invoice) => invoice.auto_invoice)).size > 1)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.auto_invoice_differs,
			message: 'Los orígenes difieren en emisión automática: el consolidado queda sin emisión automática (AND de los orígenes)',
		});
	if (new Set(invoices.map((invoice) => invoice.contract_auto_send_to_erp)).size > 1)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.auto_send_to_erp_differs,
			message: `Los contratos difieren en envío automático al ERP: el consolidado sigue al contrato principal (${
				numberOf.get(mainContractId ?? '') ?? mainContractId ?? ''
			}), que ${invoices.find((invoice) => invoice.contract_id === mainContractId)?.contract_auto_send_to_erp ? 'sí' : 'no'} envía automático`,
		});
	const pairRates = new Map<string, Set<number | null>>();

	for (const line of converting) {
		const key = pairKey(line.currency, invoiceCurrency);

		pairRates.set(key, (pairRates.get(key) ?? new Set()).add(line.fx));
	}
	const differing = [...pairRates.entries()].filter(([, set]) => set.size > 1).map(([key]) => key);

	if (!valued.spot && differing.length)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.pair_rates_differ,
			message: `Las líneas de ${differing.join(', ')} conservan tasas distintas por factura de origen (cada línea lleva la suya)`,
		});
	if (valued.spot && converting.length)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.spot_document,
			message: `Alguna línea que convierte es spot: el documento queda spot entero y se valoriza al emitir${
				consolidatedLines.some((line) => line.spot_propagated) ? ' (las líneas con tasa fija la pierden en el consolidado)' : ''
			}`,
		});
	if (requiresReferences)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.references_inherited,
			message: 'Algún contrato u origen exige OC/HES: el consolidado hereda el requisito de referencias',
		});
	if (fittedCount)
		warnings.push({
			code: CONSOLIDATION_WARNINGS.description_fitted,
			message: `${fittedCount} ${fittedCount === 1 ? 'glosa se ajustó' : 'glosas se ajustaron'} al límite del documento para anteponer el número de contrato`,
		});

	return {
		invoices: invoices.map((invoice) => ({
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			contract_id: invoice.contract_id,
			contract_number: invoice.contract_number,
			client_id: invoice.client_id,
			client_name: invoice.client_name,
			issue_date: invoice.issue_date,
			invoice_series: invoice.invoice_series,
			contract_currency: invoice.contract_currency,
			invoice_currency: invoice.invoice_currency,
			amount_contract_currency: invoice.amount_contract_currency,
			amount_invoice_currency: invoice.amount_invoice_currency,
			total_invoice_currency: invoice.total_invoice_currency,
			lines_count: invoice.lines_count,
			auto_invoice: invoice.auto_invoice,
			blockers: invoiceBlockers(invoice),
		})),
		contributions: ordered,
		main_contract_id: mainContractId,
		header,
		lines: consolidatedLines,
		references: dedupeReferences(ctx.references.filter((reference) => byId.has(reference.invoice_id))),
		warnings,
		blockers,
		can_apply: blockers.length === 0,
	};
}

// ------------------------------------------------------------------ candidatas y deshacer

/** Candidata: factura de OTRO contrato con sus bloqueos propios y los de la pareja con la base. */
export function candidateView(base: ConsolidationInvoice, candidate: ConsolidationInvoice) {
	const blockers = dedupeBlockers([...invoiceBlockers(candidate), ...pairBlockers(base, candidate)]);

	return {
		id: candidate.id,
		invoice_number: candidate.invoice_number,
		contract_id: candidate.contract_id,
		contract_number: candidate.contract_number,
		client_id: candidate.client_id,
		client_name: candidate.client_name,
		issue_date: candidate.issue_date,
		invoice_series: candidate.invoice_series,
		contract_currency: candidate.contract_currency,
		invoice_currency: candidate.invoice_currency,
		amount_contract_currency: candidate.amount_contract_currency,
		amount_invoice_currency: candidate.amount_invoice_currency,
		total_invoice_currency: candidate.total_invoice_currency,
		lines_count: candidate.lines_count,
		auto_invoice: candidate.auto_invoice,
		eligible: blockers.length === 0,
		blockers,
	};
}

/** Bloqueos de deshacer: solo un consolidado v2 (con evento) Por Emitir, sin borrador en el ERP y con orígenes. */
export function undoBlockers(
	consolidated: Pick<
		ConsolidationInvoice,
		'id' | 'invoice_number' | 'invoice_type' | 'status' | 'odoo_invoice_id' | 'sent_to_odoo_at' | 'is_active'
	>,
	hasEvent: boolean,
	originsCount: number
): InvoiceBlocker[] {
	const blockers: InvoiceBlocker[] = [];
	const name = label(consolidated);

	if (!isUnifiedType(consolidated.invoice_type)) {
		return [
			{
				code: CONSOLIDATION_BLOCKERS.not_consolidated,
				message: `La factura ${name} no es un documento consolidado`,
				next_step: null,
			},
		];
	}
	if (!hasEvent) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.legacy_unified,
			message: `${name} es un documento unificado histórico (sin evento INVOICE_CONSOLIDATED): es de solo lectura en v2`,
			next_step: LEGACY_UNIFIED_STEP,
		});
	}
	if (consolidated.status !== PENDING_STATUS || !consolidated.is_active) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.not_pending,
			message: `El consolidado ${name} no está Por Emitir (estado: ${consolidated.status ?? 'sin estado'}): ya no se puede deshacer`,
			next_step: null,
		});
	}
	const erp = erpBlocker(consolidated);

	if (erp) blockers.push(erp);
	if (hasEvent && originsCount === 0) {
		blockers.push({
			code: CONSOLIDATION_BLOCKERS.no_origins,
			message: `No se encontraron las facturas de origen de ${name}`,
			next_step: null,
		});
	}

	return blockers;
}

export * from './invoice-consolidation-read';

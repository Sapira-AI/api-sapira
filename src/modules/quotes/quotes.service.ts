import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { loadHoldingPreferences, nextQuoteNumber } from '@/core/utils/holding-preferences';
import { type FieldError, validationException } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { setApiWriter } from '@/modules/contracts/api-writer';
import { pricingFields } from '@/modules/contracts/api-written-fields';
import { itemEndDate, round2 } from '@/modules/contracts/billing-engine';
import { todayFor } from '@/modules/contracts/business-date';
import { catalogPriceErrors, catalogPriceIds, loadCatalogPrices } from '@/modules/contracts/catalog-prices';
import { cleanPaymentTerms, ContractDraftsService, parsePaymentTermsText, resolveUserId } from '@/modules/contracts/contract-drafts.service';
import { derivedStatusLateral } from '@/modules/contracts/contract-status';
import { NEXT_ITEM_END_LATERAL } from '@/modules/contracts/contracts.service';
import type { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';
import { PRICE_COLUMNS, priceSpecFromRow, priceSummaryFromRow, samePriceSpec } from '@/modules/contracts/price-rows';
import { DEFAULT_INVOICE_LINE_MODE, isMetered, priceLine, type PriceSpec, validatePriceSpec } from '@/modules/contracts/pricing-engine';

import { type ContractTarget, contractTargetsOf } from './quote-contract-targets';
import { type DiffValue, headerChanges, itemChanges, type QuoteItemSnapshot } from './quote-edit-diff';
import { itemsIncomplete, quoteTotals, type ResolvedQuoteItem, resolveQuoteItems, type StoredQuoteItem } from './quote-items';
import { QUOTE_EVENTS_LATERAL, QUOTE_NOT_DELETED, type QuoteListRow, quoteListRow, QuoteListService } from './quote-list.service';
import {
	DELETABLE_STAGE_KINDS,
	deriveQuoteStatus,
	EDIT_CONFIRMATION_STAGE_KINDS,
	isStageKind,
	normalizeQuoteType,
	QUOTE_CONTRACT_LATERAL,
	QUOTE_STATUS_LABELS,
	QUOTE_TYPE_CODES,
	QUOTE_TYPE_LABELS,
	type QuoteDerivedStatus,
	type QuoteEventType,
	type QuoteStageKind,
	quoteStatusLateral,
	transitionError,
	transitionEventType,
} from './quote-status';

import type { CreateQuoteDto, CreateQuoteItemDto, DuplicateQuoteDto, UpdateQuoteDto } from './dtos/create-quote.dto';
import type { QuoteStageTransitionDto } from './dtos/quote-stage.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);
const isoDate = (value: unknown) => {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const text = toText(value);

	return text ? text.slice(0, 10) : null;
};
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const addDays = (date: string, days: number) => {
	const parsed = new Date(`${date}T00:00:00.000Z`);

	parsed.setUTCDate(parsed.getUTCDate() + days);

	return parsed.toISOString().slice(0, 10);
};

/** Vigencia por defecto (Q-A2, Supuesto): fecha de cotización + 30 días. */
export const DEFAULT_VALID_DAYS = 30;

/**
 * Texto canónico de la condición de pago (Q-D4): es lo único que se guarda (`quotes.payment_terms`, que también leen el front viejo y
 * SF); la forma estructurada se deriva al leer con `parsePaymentTermsText` (contract-drafts), que tiene que reconocer todo lo que sale
 * de aquí (round-trip cubierto en `quotes.service.spec.ts`).
 */
export function paymentTermsText(terms: PaymentTerms | null | undefined): string | null {
	if (!terms) return null;
	if (terms.kind === 'net') return terms.days === 0 ? 'Contado' : `${terms.days} días`;
	if (terms.kind === 'end_of_month') return terms.days ? `Fin de mes + ${terms.days}` : 'Fin de mes';

	return `Día ${terms.day} del mes siguiente`;
}

/** 409 con `code` estable (mapa §6) y `message`; `errors[]` opcional (ítems incompletos). */
export const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ code, message, ...extra });

interface QuoteContext {
	client: { id: string; name: string | null; country: string | null };
	/** Nombres del contacto y vendedor elegidos (para el diff del historial). */
	contactName: string | null;
	sellerName: string | null;
	products: Map<string, string>;
	/** Precios de catálogo pedidos por `price_id`, ya como `PriceSpec` (etapa 3). */
	catalogPrices: Map<string, { spec: PriceSpec; name: string | null }>;
	draftStage: { id: string; name: string } | null;
	defaultPaymentTerms: PaymentTerms | null;
}

const ITEM_COLUMNS = `qi.id, qi.product_id, qi.product_name, qi.account, qi.item_type, qi.unit_of_measure, qi.quantity, qi.unit_price,
	qi.annual_unit_price, qi.price_entry_mode, qi.price, qi.discount_type, qi.discount_value, qi.final_price, qi.monthly_price,
	qi.billing_period_price, qi.billing_frequency, qi.billing_method, qi.start_date::text AS start_date, qi.end_date::text AS end_date,
	qi.term_months, qi.is_recurring, qi.auto_renew, qi.auto_renew_term_months, qi.currency, qi.custom_fields, qi.quote_item_number,
	qi.data_source, qi.salesforce_line_item_id, qi.price_id AS item_price_id, ${PRICE_COLUMNS}`;

/**
 * Cotizaciones v2 — 360, formulario, creación, edición, duplicado, borrado lógico, transiciones de etapa y la costura con
 * Contratos (`docs/v2-rediseno/mapa-v2-cotizaciones.md` §5 y §6). Escribe en **una transacción por operación**, acota todo al
 * holding del guard y deja un evento en `quote_events` por cada cambio. No reimplementa nada de Contratos: crear el contrato
 * delega en `ContractDraftsService.create` (que marca la etapa "Contrato creado" en su transacción).
 */
@Injectable()
export class QuotesService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly list: QuoteListService,
		private readonly contractDrafts: ContractDraftsService
	) {}

	// ---------------------------------------------------------------- lectura

	/** Fila completa de la cotización (con estado mostrado y vínculos) o 404. `$2` = hoy. */
	private async loadRow(db: Queryable, quoteId: string, holdingId: string, today: string, lock = false): Promise<Row> {
		const [row] = (await db.query(
			`SELECT ${QuoteListService.ROW_COLUMNS}, q.quote_stage_id, q.client_contact_id, q.seller_id,
				sl.email AS seller_email, sl.phone AS seller_phone, cc.email AS contact_email, cc.phone AS contact_phone,
				q.requires_multicompany, q.requires_multicurrency, q.requires_references_for_billing, q.requires_contract_document
			FROM quotes q
			LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
			LEFT JOIN clients cl ON cl.id = q.client_id
			LEFT JOIN client_contacts cc ON cc.id = q.client_contact_id
			LEFT JOIN sellers sl ON sl.id = q.seller_id
			${QUOTE_CONTRACT_LATERAL}
			${QUOTE_EVENTS_LATERAL}
			LEFT JOIN LATERAL (
				SELECT COUNT(*) AS items_count, COALESCE(SUM(qi.monthly_price) FILTER (WHERE qi.is_recurring = true), 0) AS mrr, NULL::text[] AS products
				FROM quote_items qi WHERE qi.quote_id = q.id
			) it ON true
			${quoteStatusLateral('$2')}
			WHERE q.id = $3 AND q.holding_id = $1 AND ${QUOTE_NOT_DELETED}
			${lock ? 'FOR UPDATE OF q' : ''}`,
			[holdingId, today, quoteId]
		)) as Row[];

		if (!row) throw new NotFoundException('Cotización no encontrada');

		return row;
	}

	private async loadItems(db: Queryable, quoteId: string, holdingId: string): Promise<Row[]> {
		return (await db.query(
			`SELECT ${ITEM_COLUMNS},
				lk.contract_id AS linked_contract_id, lk.contract_number AS linked_contract_number
			FROM quote_items qi
			LEFT JOIN prices p ON p.id = qi.price_id
			LEFT JOIN LATERAL (
				SELECT c.id AS contract_id, c.contract_number FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
				WHERE ci.quote_item_id = qi.id AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1
			) lk ON true
			WHERE qi.quote_id = $1 AND qi.holding_id = $2
			ORDER BY qi.quote_item_number NULLS LAST, qi.product_name, qi.id`,
			[quoteId, holdingId]
		)) as Row[];
	}

	private static itemView(row: Row) {
		const spec = row.item_price_id ? priceSpecFromRow(row) : null;
		const quantity = toNullableNumber(row.quantity);
		const startDate = toText(row.start_date);
		const term = toNullableNumber(row.term_months);
		const expectedEnd = startDate && term ? itemEndDate(startDate, term) : null;

		return {
			id: String(row.id),
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			account: toText(row.account),
			item_type: toText(row.item_type),
			unit_of_measure: toText(row.unit_of_measure),
			quantity,
			unit_price: toNullableNumber(row.unit_price),
			annual_unit_price: toNullableNumber(row.annual_unit_price),
			price_entry_mode: toText(row.price_entry_mode) ?? 'monthly',
			price: toNullableNumber(row.price),
			discount_type: toText(row.discount_type),
			discount_value: toNullableNumber(row.discount_value),
			final_price: toNullableNumber(row.final_price),
			monthly_price: toNullableNumber(row.monthly_price),
			billing_period_price: toNullableNumber(row.billing_period_price),
			billing_frequency: toText(row.billing_frequency),
			billing_method: toText(row.billing_method),
			start_date: startDate,
			end_date: toText(row.end_date),
			/** Fin esperado (inicio + plazo − 1 día); si difiere del guardado, el ítem viene de SF sin el −1 (alerta). */
			expected_end_date: expectedEnd,
			term_months: term,
			is_recurring: row.is_recurring !== false,
			auto_renew: row.auto_renew === true,
			auto_renew_term_months: toNullableNumber(row.auto_renew_term_months),
			currency: toText(row.currency),
			custom_fields: (row.custom_fields as Record<string, unknown> | null) ?? {},
			quote_item_number: toText(row.quote_item_number),
			data_source: toText(row.data_source),
			salesforce_line_item_id: toText(row.salesforce_line_item_id),
			/** Pricing v2: resumen del modelo de precio (null = standard fijo) y la línea tarifada a la cantidad base. */
			pricing: spec ? priceSummaryFromRow(row) : null,
			priced: spec ? priceLine(spec, quantity ?? 0, row.discount_type === 'Porcentaje' ? toNumber(row.discount_value) : 0) : null,
			contract: row.linked_contract_id ? { id: String(row.linked_contract_id), contract_number: toText(row.linked_contract_number) } : null,
		};
	}

	/** `GET /quotes/:id` (mapa §5c): encabezado, estado, ítems con precio, vínculos, alertas, eventos y documentos. */
	async detail(quoteId: string, holdingId: string, now = new Date()) {
		const today = todayIso(now);
		const row = await this.loadRow(this.dataSource, quoteId, holdingId, today);
		const [items, events, documents, [entitiesRow], [issuerRow], [entityRow]] = await Promise.all([
			this.loadItems(this.dataSource, quoteId, holdingId),
			this.dataSource.query<Row[]>(
				`SELECT e.id, e.type, e.from_kind, e.to_kind, e.reason, e.metadata, e.created_at,
					fs.id AS from_stage_id, fs.name AS from_stage_name, ts.id AS to_stage_id, ts.name AS to_stage_name,
					u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM quote_events e
				LEFT JOIN quote_stages fs ON fs.id = e.from_stage_id
				LEFT JOIN quote_stages ts ON ts.id = e.to_stage_id
				LEFT JOIN users u ON u.id = e.actor_id
				WHERE e.quote_id = $1 AND e.holding_id = $2
				ORDER BY e.created_at DESC, e.id DESC`,
				[quoteId, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT a.id, a.file_name, a.file_type, a.file_size, a.attachment_type, a.uploaded_at, u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM quote_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
				WHERE a.quote_id = $1 AND a.holding_id = $2 ORDER BY a.uploaded_at DESC NULLS LAST, a.id`,
				[quoteId, holdingId]
			),
			row.client_id
				? this.dataSource.query<Row[]>(
						`SELECT COUNT(*) AS entities FROM client_entities ce WHERE ce.holding_id = $2
						AND (ce.client_id = $1 OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1 AND x.holding_id = $2))`,
						[row.client_id, holdingId]
					)
				: Promise.resolve([{ entities: 0 }] as Row[]),
			// Emisor para el PDF (solo lectura): la cotización no guarda compañía; se usa la del holding en el país del cliente o, si no hay, la más antigua.
			this.dataSource.query<Row[]>(
				`SELECT h.name AS holding_name, h.logo_url AS holding_logo_url, h.website AS holding_website, h.email AS holding_email, h.phone AS holding_phone,
					co.id AS company_id, co.legal_name, co.tax_id, co.legal_address, co.country, co.email, co.phone, co.website, co.logo_url, co.tax_rate
				FROM company_holdings h
				LEFT JOIN LATERAL (
					SELECT c.* FROM companies c WHERE c.holding_id = h.id
					ORDER BY (c.country IS NOT DISTINCT FROM $2) DESC, c.created_at, c.id LIMIT 1
				) co ON true
				WHERE h.id = $1`,
				[holdingId, toText(row.client_country)]
			),
			// Razón social del cliente para el PDF: la propia del cliente primero (mismo orden que el formulario).
			row.client_id
				? this.dataSource.query<Row[]>(
						`SELECT ce.id, ce.legal_name, ce.tax_id, ce.country, ce.legal_address, ce.email FROM client_entities ce WHERE ce.holding_id = $2
						AND (ce.client_id = $1 OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1 AND x.holding_id = $2))
						ORDER BY (ce.client_id = $1) DESC, ce.legal_name LIMIT 1`,
						[row.client_id, holdingId]
					)
				: Promise.resolve([] as Row[]),
		]);
		const header = quoteListRow(row);
		const itemViews = items.map((item) => QuotesService.itemView(item));
		const alerts = QuotesService.alerts(header, itemViews, toNumber(entitiesRow?.entities), today);
		const kind = (toText(row.kind) ?? 'draft') as QuoteStageKind;
		const hasContract = header.contract !== null;
		const canCreateContract = header.status === 'signed' && !hasContract;
		const editLocked = QuotesService.editLocked(kind, hasContract);

		return {
			...header,
			contact: header.contact ? { ...header.contact, email: toText(row.contact_email), phone: toText(row.contact_phone) } : null,
			seller: header.seller ? { ...header.seller, email: toText(row.seller_email), phone: toText(row.seller_phone) } : null,
			/** Emisor del documento (PDF de la cotización), solo lectura. */
			issuer: QuotesService.issuerView(issuerRow),
			/** Razón social del cliente que va en el documento, solo lectura. */
			client_entity: entityRow
				? {
						id: String(entityRow.id),
						legal_name: toText(entityRow.legal_name),
						tax_id: toText(entityRow.tax_id),
						country: toText(entityRow.country),
						address: toText(entityRow.legal_address),
						email: toText(entityRow.email),
					}
				: null,
			client_contact_id: toText(row.client_contact_id),
			quote_stage_id: toText(row.quote_stage_id),
			status_label: QUOTE_STATUS_LABELS[header.status],
			requires_multicompany: row.requires_multicompany === true,
			requires_multicurrency: row.requires_multicurrency === true,
			requires_references_for_billing: row.requires_references_for_billing === true,
			requires_contract_document: row.requires_contract_document === true,
			totals: QuotesService.totalsOf(itemViews, header.currency),
			items: itemViews,
			links: {
				contract: header.contract?.relation === 'created' ? header.contract : null,
				applied_to: header.contract?.relation === 'applied' ? [header.contract] : [],
				client: header.client ? { id: header.client.id, name: header.client.name } : null,
			},
			alerts,
			can_edit: !editLocked,
			/** Editar una firmada/perdida exige confirmarlo (`confirm_edit_after_signature`); el cambio queda con el diff en el historial. */
			edit_requires_confirmation: !editLocked && EDIT_CONFIRMATION_STAGE_KINDS.includes(kind),
			can_delete: DELETABLE_STAGE_KINDS.includes(kind) && !hasContract,
			can_create_contract: canCreateContract,
			can_apply_to_contract: canCreateContract,
			events: events.map((event) => ({
				id: String(event.id),
				type: toText(event.type),
				from_stage: event.from_stage_id ? { id: String(event.from_stage_id), name: toText(event.from_stage_name) } : null,
				to_stage: event.to_stage_id ? { id: String(event.to_stage_id), name: toText(event.to_stage_name) } : null,
				from_kind: toText(event.from_kind),
				to_kind: toText(event.to_kind),
				reason: toText(event.reason),
				metadata: (event.metadata as Record<string, unknown> | null) ?? {},
				created_at: iso(event.created_at),
				actor: event.user_id ? { id: String(event.user_id), name: toText(event.user_name) } : null,
			})),
			documents: documents.map((document) => ({
				id: String(document.id),
				file_name: toText(document.file_name),
				file_type: toText(document.file_type),
				file_size: toNullableNumber(document.file_size),
				attachment_type: toText(document.attachment_type),
				uploaded_at: iso(document.uploaded_at),
				uploaded_by: document.user_id ? { id: String(document.user_id), name: toText(document.user_name) } : null,
			})),
		};
	}

	/** Emisor del PDF: la compañía elegida y, si falta, los datos del holding (nombre, logo, sitio). `null` sin holding. */
	private static issuerView(row: Row | undefined) {
		if (!row) return null;

		return {
			company_id: row.company_id ? String(row.company_id) : null,
			legal_name: toText(row.legal_name) ?? toText(row.holding_name),
			trade_name: toText(row.holding_name),
			tax_id: toText(row.tax_id),
			address: toText(row.legal_address),
			country: toText(row.country),
			email: toText(row.email) ?? toText(row.holding_email),
			phone: toText(row.phone) ?? toText(row.holding_phone),
			website: toText(row.website) ?? toText(row.holding_website),
			logo_url: toText(row.logo_url) ?? toText(row.holding_logo_url),
			/** Tasa de impuesto de la compañía en porcentaje (19 = 19 %); `null` si no está configurada. */
			tax_rate: toNullableNumber(row.tax_rate),
		};
	}

	private static totalsOf(items: ReturnType<typeof QuotesService.itemView>[], currency: string | null) {
		const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));
		const recurring = items.filter((item) => item.is_recurring);
		const byFrequency = new Map<string, number>();

		for (const item of items) {
			const key = item.is_recurring ? `${item.billing_frequency ?? 'Mensual'} ${item.billing_method ?? ''}`.trim() : 'Una vez';

			byFrequency.set(key, round2((byFrequency.get(key) ?? 0) + (item.billing_period_price ?? 0)));
		}

		return {
			currency,
			total_amount: sum(items.map((item) => item.final_price ?? 0)),
			mrr: sum(recurring.map((item) => item.monthly_price ?? 0)),
			one_time: sum(items.filter((item) => !item.is_recurring).map((item) => item.final_price ?? 0)),
			by_frequency: [...byFrequency.entries()].map(([label, amount]) => ({ label, amount })),
		};
	}

	/** Alertas del Resumen (§5c). */
	static alerts(header: QuoteListRow, items: ReturnType<typeof QuotesService.itemView>[], entities: number, today: string) {
		const alerts: Array<{ code: string; severity: 'error' | 'warning' | 'info'; message: string; count?: number }> = [];
		const push = (code: string, severity: 'error' | 'warning' | 'info', message: string, count?: number) => {
			if (count === undefined || count > 0) alerts.push({ code, severity, message, ...(count !== undefined ? { count } : {}) });
		};
		const withoutProduct = items.filter((item) => !item.product_id).length;
		const withoutStart = items.filter((item) => !item.start_date).length;
		const endOff = items.filter((item) => item.expected_end_date && item.end_date && item.end_date !== item.expected_end_date).length;
		const currencyOff = items.filter(
			(item) => item.currency && header.currency && item.currency.toUpperCase() !== header.currency.toUpperCase()
		).length;
		const sumFinal = round2(items.reduce((sum, item) => sum + (item.final_price ?? 0), 0));

		push('items_without_product', 'error', 'Ítems sin producto del catálogo: elígelo antes de firmar', withoutProduct);
		push('items_without_start', 'error', 'Ítems sin fecha de inicio', withoutStart);
		push(
			'items_end_date_off',
			'warning',
			'Ítems con fin distinto de inicio + plazo − 1 día (heredado de Salesforce); se corrige al editar',
			endOff
		);
		push('items_currency_mismatch', 'warning', 'Ítems en una moneda distinta de la cotización', currencyOff);
		if (header.payment_terms && !header.payment_terms_json) {
			push(
				'payment_terms_unparsed',
				'warning',
				`La condición de pago "${header.payment_terms}" no se interpreta: elígela al crear el contrato`
			);
		}
		if (header.client && entities === 0)
			push('client_without_entities', 'warning', 'El cliente no tiene razones sociales: crea una antes del contrato');
		if (header.status === 'expired') push('expired', 'warning', `Vencida el ${header.valid_until}`);
		else if (header.valid_until && ['draft', 'sent'].includes(header.status) && header.valid_until <= addDays(today, 7)) {
			push('expiring_soon', 'info', `Vence el ${header.valid_until}`);
		}
		if (items.length && Math.abs(sumFinal - header.total_amount) > 0.01) {
			push(
				'total_mismatch',
				'info',
				`El total guardado (${header.total_amount}) no coincide con la suma de los ítems (${sumFinal}); se alinea al guardar`
			);
		}
		if (header.status === 'signed' && !header.contract)
			push('signed_without_contract', 'info', 'Firmada sin contrato: crea el contrato o aplícala a uno existente');

		return alerts;
	}

	/** `GET /quotes/:id/form`: la cotización en la forma exacta del body de crear/editar (con `items[].id`). */
	async form(quoteId: string, holdingId: string, now = new Date()) {
		const today = todayIso(now);
		const row = await this.loadRow(this.dataSource, quoteId, holdingId, today);
		const items = await this.loadItems(this.dataSource, quoteId, holdingId);
		const header = quoteListRow(row);
		const kind = (toText(row.kind) ?? 'draft') as QuoteStageKind;
		const optional = <T>(key: string, value: T | null | undefined) => (value === null || value === undefined ? {} : { [key]: value });
		const code = QUOTE_TYPE_CODES.includes(header.quote_type as never) ? header.quote_type : null;

		return {
			id: header.id,
			quote_number: header.quote_number,
			status: header.status,
			editable: !QuotesService.editLocked(kind, header.contract !== null),
			/** Único bloqueo de edición (Domi 02-10): tener contrato (vínculo o etapa "Contrato creado"). */
			edit_blocker: QuotesService.editLocked(kind, header.contract !== null) ? ('quote_has_contract' as const) : null,
			edit_requires_confirmation: !QuotesService.editLocked(kind, header.contract !== null) && EDIT_CONFIRMATION_STAGE_KINDS.includes(kind),
			created_at: header.created_at,
			form: {
				client_id: header.client?.id ?? null,
				...optional('client_contact_id', toText(row.client_contact_id)),
				...optional('seller_id', header.seller?.id),
				quote_type: code,
				quote_type_raw: toText(row.quote_type),
				quote_date: header.quote_date,
				valid_until: header.valid_until,
				booking_date: header.booking_date,
				currency: header.currency,
				payment_terms: header.payment_terms_json,
				...optional('payment_terms_text', header.payment_terms),
				...optional('notes', header.notes),
				requires_multicompany: row.requires_multicompany === true,
				requires_multicurrency: row.requires_multicurrency === true,
				requires_references_for_billing: row.requires_references_for_billing === true,
				requires_contract_document: row.requires_contract_document === true,
				items: items.map((item) => {
					const spec = item.item_price_id ? priceSpecFromRow(item) : null;
					const annual = item.price_entry_mode === 'annual';

					return {
						id: String(item.id),
						key: String(item.id),
						product_id: toText(item.product_id),
						...optional('product_name', toText(item.product_name)),
						...optional('account', toText(item.account)),
						item_type: toText(item.item_type) ?? '',
						...optional('unit_of_measure', toText(item.unit_of_measure)),
						quantity: toNullableNumber(item.quantity) ?? 1,
						...(spec
							? { price: spec }
							: annual
								? { annual_unit_price: toNullableNumber(item.annual_unit_price) ?? 0, price_entry_mode: 'annual' as const }
								: { unit_price: toNullableNumber(item.unit_price) ?? 0, price_entry_mode: 'monthly' as const }),
						discount_value: item.discount_type === 'Porcentaje' ? (toNullableNumber(item.discount_value) ?? 0) : 0,
						...(item.discount_type === 'Monto fijo' && toNumber(item.discount_value) > 0
							? { discount_fixed_amount: toNumber(item.discount_value) }
							: {}),
						billing_frequency: toText(item.billing_frequency) ?? 'Mensual',
						billing_method: toText(item.billing_method) ?? 'Anticipado',
						start_date: toText(item.start_date),
						term_months: toNullableNumber(item.term_months) ?? 12,
						is_recurring: item.is_recurring !== false,
						auto_renew: item.auto_renew === true,
						...optional('auto_renew_term_months', toNullableNumber(item.auto_renew_term_months)),
						custom_fields: (item.custom_fields as Record<string, unknown> | null) ?? {},
						linked_contract: item.linked_contract_id
							? { id: String(item.linked_contract_id), contract_number: toText(item.linked_contract_number) }
							: null,
					};
				}),
			},
		};
	}

	// ---------------------------------------------------------------- opciones del formulario

	/** `GET /quotes/form-options` (mapa §6): catálogos del holding y defaults para el cliente (`?clientId=`). */
	async formOptions(holdingId: string, options: { clientId?: string } = {}) {
		const clientId = options.clientId ?? null;
		const [
			clients,
			contacts,
			sellers,
			stages,
			currencies,
			products,
			masterData,
			usedTypes,
			usedUnits,
			metrics,
			[settings],
			entities,
			[contractsRow],
			[lastContract],
			prefs,
		] = await Promise.all([
			this.dataSource.query<Row[]>(`SELECT id, name_commercial AS name, country FROM clients WHERE holding_id = $1 ORDER BY name_commercial`, [
				holdingId,
			]),
			clientId
				? this.dataSource.query<Row[]>(
						`SELECT id, name, email, position FROM client_contacts WHERE client_id = $1 AND holding_id = $2 ORDER BY name`,
						[clientId, holdingId]
					)
				: Promise.resolve([] as Row[]),
			this.dataSource.query<Row[]>(`SELECT id, name, email FROM sellers WHERE holding_id = $1 AND is_active = true ORDER BY name`, [holdingId]),
			this.dataSource.query<Row[]>(`SELECT id, name, color, kind, position FROM quote_stages WHERE holding_id = $1 ORDER BY position, name`, [
				holdingId,
			]),
			this.dataSource.query<Row[]>(`SELECT code FROM currencies WHERE is_active = true ORDER BY code`),
			this.dataSource.query<Row[]>(
				`SELECT p.id, p.name, p.product_code, p.default_currency, p.default_price, p.is_recurring,
						(SELECT COUNT(*) FROM prices pr WHERE pr.product_id = p.id AND pr.owner = 'catalog' AND pr.status = 'active') AS catalog_prices
					FROM products p WHERE p.holding_id = $1 ORDER BY p.name`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT category, value FROM master_data WHERE holding_id = $1 AND is_active = true AND category IN ('item_types', 'units_of_measure', 'payment_terms') ORDER BY category, value`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT qi.item_type AS value FROM quote_items qi WHERE qi.holding_id = $1 AND qi.item_type IS NOT NULL ORDER BY 1`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT qi.unit_of_measure AS value FROM quote_items qi WHERE qi.holding_id = $1 AND qi.unit_of_measure IS NOT NULL ORDER BY 1`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT id, code, name, unit, aggregation FROM billable_metrics WHERE holding_id = $1 AND status = 'active' ORDER BY name`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [holdingId]),
			clientId
				? this.dataSource.query<Row[]>(
						`SELECT ce.id, ce.legal_name, ce.country, ce.payment_terms FROM client_entities ce WHERE ce.holding_id = $2
							AND (ce.client_id = $1 OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1 AND x.holding_id = $2))
							ORDER BY (ce.client_id = $1) DESC, ce.legal_name`,
						[clientId, holdingId]
					)
				: Promise.resolve([] as Row[]),
			clientId
				? this.dataSource.query<Row[]>(
						`SELECT COUNT(*) AS active FROM contracts c WHERE c.client_id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL AND c.status = 'Activo'`,
						[clientId, holdingId]
					)
				: Promise.resolve([{ active: 0 }] as Row[]),
			clientId
				? this.dataSource.query<Row[]>(
						`SELECT c.contract_currency FROM contracts c WHERE c.client_id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 1`,
						[clientId, holdingId]
					)
				: Promise.resolve([] as Row[]),
			loadHoldingPreferences(this.dataSource, holdingId),
		]);
		const byCategory = (category: string) => masterData.filter((row) => row.category === category).map((row) => String(row.value));
		const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y, 'es'));
		const defaultEntity = entities.find((entity) => cleanPaymentTerms(entity.payment_terms)) ?? null;
		const activeContracts = toNumber(contractsRow?.active);
		const systemCurrency = toText(settings?.system_currency) ?? 'USD';

		return {
			clients: clients.map((row) => ({ id: String(row.id), name: toText(row.name), country: toText(row.country) })),
			contacts: contacts.map((row) => ({
				id: String(row.id),
				name: toText(row.name),
				email: toText(row.email),
				position: toText(row.position),
			})),
			sellers: sellers.map((row) => ({ id: String(row.id), name: toText(row.name), email: toText(row.email) })),
			quote_types: QUOTE_TYPE_CODES.map((code) => ({ value: code, label: QUOTE_TYPE_LABELS[code] })),
			stages: stages.map((row) => ({
				id: String(row.id),
				name: toText(row.name),
				color: toText(row.color),
				kind: toText(row.kind) ?? 'draft',
				position: toNumber(row.position),
			})),
			currencies: currencies.map((row) => String(row.code)),
			products: products.map((row) => ({
				id: String(row.id),
				name: toText(row.name),
				product_code: toText(row.product_code),
				default_currency: toText(row.default_currency),
				default_price: toNullableNumber(row.default_price),
				is_recurring: row.is_recurring !== false,
				catalog_prices: toNumber(row.catalog_prices),
			})),
			item_types: merge(
				byCategory('item_types'),
				usedTypes.map((row) => String(row.value))
			),
			units_of_measure: merge(
				byCategory('units_of_measure'),
				usedUnits.map((row) => String(row.value))
			),
			payment_terms_presets: byCategory('payment_terms').map((label) => ({ label, terms: parsePaymentTermsText(label) })),
			billable_metrics: metrics.map((row) => ({
				id: String(row.id),
				code: toText(row.code),
				name: toText(row.name),
				unit: toText(row.unit),
				aggregation: toText(row.aggregation),
			})),
			billing_frequencies: ['Mensual', 'Trimestral', 'Semestral', 'Anual', 'Bianual'],
			billing_methods: ['Anticipado', 'Vencido'],
			client: clientId
				? {
						id: clientId,
						entities: entities.map((entity) => ({
							id: String(entity.id),
							legal_name: toText(entity.legal_name),
							country: toText(entity.country),
							payment_terms: cleanPaymentTerms(entity.payment_terms),
						})),
						active_contracts: activeContracts,
					}
				: null,
			// Configuración ronda 4: si el formulario pide el número (manual) y el próximo número (vista previa) en los automáticos.
			quote_numbering: {
				mode: prefs.quote_numbering.mode,
				next_number_preview: await nextQuoteNumber(
					this.dataSource,
					holdingId,
					prefs.quote_numbering,
					Number(todayFor(prefs.timezone).slice(0, 4))
				),
			},
			defaults: {
				quote_date: todayIso(),
				valid_days: DEFAULT_VALID_DAYS,
				currency: toText(lastContract?.contract_currency) ?? systemCurrency,
				payment_terms: defaultEntity ? cleanPaymentTerms(defaultEntity.payment_terms) : null,
				/** `new_business` si el cliente no tiene contratos activos, `upsell` si tiene (mismo criterio que S3-3). */
				suggested_quote_type: clientId ? (activeContracts > 0 ? 'upsell' : 'new_business') : null,
			},
		};
	}

	// ---------------------------------------------------------------- contexto compartido (preview, crear y editar)

	/** Cliente, contacto, vendedor, productos, precios de catálogo, métricas y etapa de borrador del holding; junta los errores por campo (400). */
	private async loadContext(db: Queryable, dto: CreateQuoteDto, holdingId: string): Promise<QuoteContext> {
		const errors: FieldError[] = [];
		const productIds = [...new Set(dto.items.map((item) => item.product_id))];
		const catalogIds = catalogPriceIds(dto.items);
		const metricIds = [
			...new Set(dto.items.map((item) => item.price?.billable_metric_id).filter((id): id is string => typeof id === 'string' && id.length > 0)),
		];
		const [[client], [contact], [seller], products, catalog, metrics, [draftStage], entities] = await Promise.all([
			db.query(`SELECT id, name_commercial, country FROM clients WHERE id = $1 AND holding_id = $2`, [dto.client_id, holdingId]) as Promise<
				Row[]
			>,
			dto.client_contact_id
				? (db.query(`SELECT id, client_id, name FROM client_contacts WHERE id = $1 AND holding_id = $2`, [
						dto.client_contact_id,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			dto.seller_id
				? (db.query(`SELECT id, name FROM sellers WHERE id = $1 AND holding_id = $2`, [dto.seller_id, holdingId]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			db.query(`SELECT id, name FROM products WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [productIds, holdingId]) as Promise<Row[]>,
			loadCatalogPrices(db, catalogIds, holdingId),
			metricIds.length
				? (db.query(`SELECT id, status FROM billable_metrics WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
						metricIds,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			db.query(`SELECT id, name FROM quote_stages WHERE holding_id = $1 AND kind = 'draft' ORDER BY position, name LIMIT 1`, [
				holdingId,
			]) as Promise<Row[]>,
			db.query(
				`SELECT ce.payment_terms FROM client_entities ce WHERE ce.holding_id = $2
				AND (ce.client_id = $1 OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = $1 AND x.holding_id = $2))
				ORDER BY (ce.client_id = $1) DESC, ce.legal_name`,
				[dto.client_id, holdingId]
			) as Promise<Row[]>,
		]);

		if (!client) errors.push({ field: 'client_id', message: 'El cliente no existe en el holding' });
		if (dto.client_contact_id && (!contact || (client && String(contact.client_id) !== String(client.id)))) {
			errors.push({ field: 'client_contact_id', message: 'El contacto no pertenece al cliente' });
		}
		if (dto.seller_id && !seller) errors.push({ field: 'seller_id', message: 'El vendedor no existe en el holding' });
		const productMap = new Map(products.map((row) => [String(row.id), toText(row.name) ?? 'Producto']));
		const metricMap = new Map(metrics.map((row) => [String(row.id), row]));
		const catalogPrices = new Map<string, { spec: PriceSpec; name: string | null }>();

		dto.items.forEach((item, index) => {
			const field = (name: string) => `items.${index}.${name}`;

			if (!productMap.has(item.product_id))
				errors.push({ field: field('product_id'), message: 'El producto no existe en el catálogo del holding' });
			if (item.price_id) {
				// Mismas reglas que Contratos (etapa 3): existe en el holding, activo, del producto y de la moneda de la cotización, sin inline.
				const catalogPrice = catalog.get(item.price_id);
				const catalogErrors = catalogPriceErrors({
					field: `items.${index}`,
					catalog: catalogPrice,
					inline: Boolean(item.price),
					product_id: item.product_id,
					contract_currency: dto.currency,
				});

				errors.push(...catalogErrors);
				if (!catalogErrors.length && catalogPrice)
					catalogPrices.set(item.price_id, { spec: catalogPrice.spec, name: catalogPrice.name || null });
			}
			if (item.price) {
				for (const error of validatePriceSpec(item.price)) errors.push({ field: field(`price.${error.field}`), message: error.message });
				const metricId = item.price.billable_metric_id;

				if (metricId && !metricMap.has(metricId))
					errors.push({ field: field('price.billable_metric_id'), message: 'La métrica facturable no existe en el holding' });
				else if (metricId && metricMap.get(metricId)?.status !== 'active')
					errors.push({ field: field('price.billable_metric_id'), message: 'La métrica facturable está archivada' });
				if (isMetered(item.price) && item.billing_method === 'Anticipado' && item.price.model !== 'seat') {
					errors.push({
						field: field('billing_method'),
						message: 'Un ítem por consumo se factura Vencido: el consumo se conoce al cerrar el período',
					});
				}
			}
		});
		if (errors.length) throw validationException(errors);

		return {
			client: { id: String(client.id), name: toText(client.name_commercial), country: toText(client.country) },
			contactName: toText(contact?.name),
			sellerName: toText(seller?.name),
			products: productMap,
			catalogPrices,
			draftStage: draftStage ? { id: String(draftStage.id), name: String(draftStage.name) } : null,
			defaultPaymentTerms: (entities.map((row) => cleanPaymentTerms(row.payment_terms)).find(Boolean) as PaymentTerms | undefined) ?? null,
		};
	}

	/** Ítems del DTO con los precios de catálogo ya copiados como `price` (etapa 3: el ítem guarda su propia copia negociada). */
	private static withCatalogPrices(dto: CreateQuoteDto, context: QuoteContext): CreateQuoteItemDto[] {
		return dto.items.map((item) => {
			if (!item.price_id) return item;
			const catalog = context.catalogPrices.get(item.price_id);

			return catalog ? { ...item, price: catalog.spec as CreateQuoteItemDto['price'] } : item;
		});
	}

	/**
	 * Condición de pago a guardar (Q-D4): manda la estructurada (`payment_terms`, o la de la razón social por defecto) y se escribe su
	 * texto canónico; si solo viene `payment_terms_text`, tiene que interpretarse (`parsePaymentTermsText`) y se guarda también canónico,
	 * porque `quotes.payment_terms` es la única fuente y la forma estructurada se deriva de ese texto al leer. Texto no interpretable → 400.
	 */
	static resolvePaymentTerms(dto: Pick<CreateQuoteDto, 'payment_terms' | 'payment_terms_text'>, defaults: PaymentTerms | null) {
		const structured = dto.payment_terms ? cleanPaymentTerms(dto.payment_terms) : dto.payment_terms === null ? null : undefined;
		const text = dto.payment_terms_text?.trim() || null;

		if (structured === undefined && text) {
			const parsed = parsePaymentTermsText(text);

			if (!parsed) {
				throw validationException([
					{
						field: 'payment_terms_text',
						message: `La condición de pago "${text}" no se interpreta: usa "30 días", "Contado", "Fin de mes + 15" o "Día 5 del mes siguiente"`,
					},
				]);
			}

			return { terms: parsed, termsText: paymentTermsText(parsed) };
		}
		const terms = structured === undefined ? defaults : structured;

		return { terms, termsText: paymentTermsText(terms) };
	}

	/** Valores del encabezado compartidos por crear y editar. */
	private static headerValues(dto: CreateQuoteDto, context: QuoteContext, resolved: ResolvedQuoteItem[], now = new Date()) {
		const { terms, termsText } = QuotesService.resolvePaymentTerms(dto, context.defaultPaymentTerms);
		const quoteDate = dto.quote_date ?? todayIso(now);
		const validUntil = dto.valid_until === null ? null : (dto.valid_until ?? addDays(quoteDate, DEFAULT_VALID_DAYS));

		return { quoteDate, validUntil, terms, termsText, totals: quoteTotals(resolved) };
	}

	/** `POST /quotes/preview`: ítems tarifados, totales y avisos; no escribe. */
	async preview(dto: CreateQuoteDto, holdingId: string) {
		const context = await this.loadContext(this.dataSource, dto, holdingId);
		const resolved = resolveQuoteItems(QuotesService.withCatalogPrices(dto, context), context.products);
		const header = QuotesService.headerValues(dto, context, resolved);
		const warnings: string[] = [];

		if (!context.draftStage) warnings.push('El holding no tiene una etapa de tipo borrador: configúrala en Etapas antes de guardar');
		if (!header.terms) warnings.push('Sin condición de pago: se pedirá al crear el contrato');
		for (const item of resolved) {
			if (item.priced) item.priced.warnings.forEach((warning) => warnings.push(`"${item.product_name}": ${warning}`));
			if (item.final_price <= 0 && !item.price_spec) warnings.push(`"${item.product_name}" queda con precio 0: no se podrá marcar firmada`);
		}

		return {
			currency: dto.currency,
			quote_date: header.quoteDate,
			valid_until: header.validUntil,
			payment_terms: header.terms,
			payment_terms_text: header.termsText,
			items: resolved.map((item) => ({
				item_key: item.key,
				product_id: item.dto.product_id,
				product_name: item.product_name,
				quantity: item.dto.quantity,
				unit_price: item.unit_price,
				annual_unit_price: item.annual_unit_price,
				price_entry_mode: item.price_entry_mode,
				discount_pct: item.discount_pct,
				price: item.price,
				final_price: item.final_price,
				monthly_price: item.monthly_price,
				billing_period_price: item.billing_period_price,
				start_date: item.dto.start_date,
				end_date: item.end_date,
				term_months: item.dto.term_months,
				is_recurring: item.is_recurring,
				pricing: item.price_spec,
				priced: item.priced,
			})),
			totals: header.totals,
			warnings,
		};
	}

	// ---------------------------------------------------------------- crear

	/**
	 * `POST /quotes`: crea la cotización en la etapa `kind = draft` del holding en **una transacción**: número (manual único en el
	 * holding, o correlativo `COT-{año}-{NNNN}` con lock por holding y año), encabezado, ítems con sus precios inline y evento `CREATED`.
	 */
	async create(dto: CreateQuoteDto, holdingId: string, authId: string, now = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		let quoteId: string;

		try {
			const context = await this.loadContext(runner, dto, holdingId);

			if (!context.draftStage)
				throw conflict('stage_kind_missing', 'El holding no tiene una etapa de tipo borrador (kind draft): configúrala en Etapas');
			const resolved = resolveQuoteItems(QuotesService.withCatalogPrices(dto, context), context.products);
			const header = QuotesService.headerValues(dto, context, resolved, now);
			const quoteNumber = await this.reserveNumber(runner, dto.quote_number, holdingId, now);

			quoteId = await this.insertQuote(runner, {
				holdingId,
				dto,
				context,
				header,
				quoteNumber,
				stageId: context.draftStage.id,
				salesforceOpportunityId: null,
			});
			const itemIds = await this.insertItems(runner, quoteId, holdingId, dto.currency, resolved, userId, context);

			await this.insertEvent(runner, {
				quoteId,
				holdingId,
				type: 'CREATED',
				toStageId: context.draftStage.id,
				toKind: 'draft',
				userId,
				metadata: { source: 'api_v2', quote_number: quoteNumber, total_amount: header.totals.total_amount, items: itemIds },
			});
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.detail(quoteId, holdingId, now);
	}

	/**
	 * Número según la preferencia del holding (`holding_settings.quote_numbering_*`, Configuración ronda 4):
	 * - `manual`: lo escribe la usuaria (obligatorio, 400 si falta) → 409 `quote_number_taken` si ya existe en el holding (también borradas).
	 * - `prefixed` (default, `COT-{año}-{NNNN}`) / `sequential` (`NNNN`): lo genera la API (mayor del formato + 1, con
	 *   `pg_advisory_xact_lock` por holding y formato); un número escrito a mano → 400.
	 * El año es el del "hoy" del holding (su zona horaria). Las cotizaciones del CRM no pasan por aquí (conservan el id de la oportunidad).
	 */
	private async reserveNumber(runner: QueryRunner, manual: string | undefined, holdingId: string, now: Date): Promise<string> {
		const prefs = await loadHoldingPreferences(runner, holdingId);
		const numbering = prefs.quote_numbering;

		if (numbering.mode !== 'manual') {
			if (manual)
				throw validationException([
					{ field: 'quote_number', message: 'Este holding numera las cotizaciones automáticamente: no escribas el número' },
				]);

			return (await nextQuoteNumber(runner, holdingId, numbering, Number(todayFor(prefs.timezone, now).slice(0, 4)), true))!;
		}
		if (!manual)
			throw validationException([{ field: 'quote_number', message: 'Escribe el número de la cotización (el holding usa numeración manual)' }]);
		await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quotes:${holdingId}:number:${manual}`]);
		const [existing] = (await runner.query(`SELECT 1 FROM quotes WHERE holding_id = $1 AND quote_number = $2 LIMIT 1`, [
			holdingId,
			manual,
		])) as Row[];

		if (existing) throw conflict('quote_number_taken', `Ya existe una cotización con el número ${manual}`);

		return manual;
	}

	private async insertQuote(
		runner: QueryRunner,
		input: {
			holdingId: string;
			dto: CreateQuoteDto;
			context: QuoteContext;
			header: ReturnType<typeof QuotesService.headerValues>;
			quoteNumber: string;
			stageId: string;
			salesforceOpportunityId: string | null;
		}
	): Promise<string> {
		const { dto, header } = input;
		// Quién la creó queda en el evento `CREATED`; `updated_at` lo pone el trigger `quotes_set_updated_at`.
		const [row] = (await runner.query(
			`INSERT INTO quotes (
				holding_id, client_id, client_contact_id, seller_id, quote_stage_id, quote_number, quote_type, quote_date, valid_until,
				booking_date, currency, total_amount, payment_terms, notes,
				requires_multicompany, requires_multicurrency, requires_references_for_billing, requires_contract_document,
				salesforce_opportunity_id, created_at
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8::date, $9::date,
				$10::date, $11, $12, $13, $14,
				$15, $16, $17, $18,
				$19, now()
			) RETURNING id`,
			[
				input.holdingId,
				input.context.client.id,
				dto.client_contact_id ?? null,
				dto.seller_id ?? null,
				input.stageId,
				input.quoteNumber,
				dto.quote_type,
				header.quoteDate,
				header.validUntil,
				dto.booking_date ?? null,
				dto.currency,
				header.totals.total_amount,
				header.termsText,
				dto.notes ?? null,
				dto.requires_multicompany === true,
				dto.requires_multicurrency === true,
				dto.requires_references_for_billing === true,
				dto.requires_contract_document === true,
				input.salesforceOpportunityId,
			]
		)) as Row[];

		return String(row.id);
	}

	/**
	 * Valores de un ítem resuelto para `quote_items` (mismos en INSERT y UPDATE). Con la costura `sapira.writer = 'api'` las
	 * columnas derivadas (unitario mensual en modo anual, anual, total anual, `monthly_price`, `billing_period_price`) las
	 * escribe la API con la réplica de `auto_calculate_pricing_fields` (`pricingFields`): quedan iguales a lo que dejaba el
	 * trigger. Los totales que devuelve la API (`quoteTotals`) siguen saliendo de los ítems resueltos.
	 */
	private static itemValues(item: ResolvedQuoteItem, currency: string) {
		const prices = pricingFields(
			{
				unit_price: item.unit_price,
				annual_unit_price: item.annual_unit_price,
				price_entry_mode: item.price_entry_mode,
				quantity: item.dto.quantity,
				billing_frequency: item.dto.billing_frequency,
				is_recurring: item.is_recurring,
				final_price: item.final_price,
				term_months: item.dto.term_months ?? null,
				discount_type: item.discount_pct > 0 ? 'Porcentaje' : null,
				discount_value: item.discount_pct,
			},
			'quote_items'
		);

		return [
			item.dto.product_id,
			item.product_name,
			item.dto.account || null,
			item.dto.item_type,
			item.dto.unit_of_measure || null,
			item.dto.quantity,
			prices.unit_price,
			prices.annual_unit_price,
			prices.price_entry_mode,
			item.discount_pct > 0 ? 'Porcentaje' : null,
			item.discount_pct,
			item.price,
			item.final_price,
			prices.monthly_price,
			prices.billing_period_price,
			currency,
			item.dto.billing_frequency,
			item.dto.billing_method,
			item.dto.start_date,
			item.end_date,
			item.dto.term_months,
			item.is_recurring,
			item.dto.auto_renew === true,
			item.dto.auto_renew_term_months ?? null,
			JSON.stringify(item.dto.custom_fields ?? {}),
			prices.annual_price,
		];
	}

	private async insertItems(
		runner: QueryRunner,
		quoteId: string,
		holdingId: string,
		currency: string,
		items: ResolvedQuoteItem[],
		userId: string,
		context: QuoteContext
	): Promise<string[]> {
		const ids: string[] = [];

		for (const item of items) {
			const [row] = (await runner.query(
				`INSERT INTO quote_items (
					quote_id, holding_id, product_id, product_name, account, item_type, unit_of_measure, quantity, unit_price, annual_unit_price,
					price_entry_mode, discount_type, discount_value, price, final_price, monthly_price, billing_period_price, currency,
					billing_frequency, billing_method, start_date, end_date, term_months, is_recurring, auto_renew, auto_renew_term_months,
					custom_fields, annual_price, data_source
				) VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
					$11, $12, $13, $14, $15, $16, $17, $18,
					$19, $20, $21::date, $22::date, $23, $24, $25, $26,
					$27::jsonb, $28, 'manual'
				) RETURNING id`,
				[quoteId, holdingId, ...QuotesService.itemValues(item, currency)]
			)) as Row[];
			const itemId = String(row.id);

			ids.push(itemId);
			if (item.price_spec) {
				await this.insertPrice(runner, {
					quoteId,
					holdingId,
					itemId,
					item,
					currency,
					userId,
					listPriceId: item.dto.price_id ?? null,
					context,
				});
			}
		}

		return ids;
	}

	/** Pricing v2: INSERT en `prices` (owner = quote, activo) y `quote_items.price_id`. Con `supersedes` versiona y archiva la anterior. */
	private async insertPrice(
		runner: QueryRunner,
		input: {
			quoteId: string;
			holdingId: string;
			itemId: string;
			item: ResolvedQuoteItem;
			currency: string;
			userId: string;
			listPriceId: string | null;
			context: QuoteContext;
			supersedes?: { id: string; version: number } | null;
		}
	): Promise<string> {
		const spec = input.item.price_spec!;
		const name = (input.listPriceId && input.context.catalogPrices.get(input.listPriceId)?.name) || input.item.product_name;
		const [row] = (await runner.query(
			`INSERT INTO prices (
				holding_id, owner, product_id, quote_id, name, currency, model, quantity_type, billable_metric_id,
				unit_amount, tiers, package_size, package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount,
				status, version, supersedes_price_id, list_price_id, created_by, updated_by, published_at, invoice_line_mode, charge_flat_when_free
			) VALUES (
				$1, 'quote', $2, $3, $4, $5, $6, $7, $8,
				$9, $10::jsonb, $11, $12, $13, $14, $15, $16,
				'active', $17, $18, $19, $20, $20, now(), $21, $22
			) RETURNING id`,
			[
				input.holdingId,
				input.item.dto.product_id,
				input.quoteId,
				name,
				input.currency,
				spec.model,
				spec.quantity_type,
				spec.billable_metric_id ?? null,
				spec.unit_amount ?? null,
				spec.tiers ? JSON.stringify(spec.tiers) : null,
				spec.package_size ?? null,
				spec.package_amount ?? null,
				spec.seat_minimum_quantity ?? 0,
				spec.free_units ?? 0,
				spec.minimum_amount ?? null,
				spec.cap_amount ?? null,
				input.supersedes ? input.supersedes.version + 1 : 1,
				input.supersedes?.id ?? null,
				input.listPriceId,
				input.userId,
				spec.invoice_line_mode ?? DEFAULT_INVOICE_LINE_MODE,
				spec.charge_flat_when_free === true,
			]
		)) as Row[];
		const priceId = String(row.id);

		await runner.query(`UPDATE quote_items SET price_id = $3 WHERE id = $1 AND holding_id = $2`, [input.itemId, input.holdingId, priceId]);
		if (input.supersedes) await this.archivePrices(runner, [input.supersedes.id], input.holdingId, input.userId);

		return priceId;
	}

	private async archivePrices(runner: QueryRunner, priceIds: string[], holdingId: string, userId: string): Promise<void> {
		if (!priceIds.length) return;
		await runner.query(
			`UPDATE prices SET status = 'archived', archived_at = now(), updated_at = now(), updated_by = $3
			WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND owner = 'quote' AND status <> 'archived'`,
			[priceIds, holdingId, userId]
		);
	}

	private async insertEvent(
		runner: Queryable,
		input: {
			quoteId: string;
			holdingId: string;
			type: QuoteEventType;
			userId: string;
			fromStageId?: string | null;
			toStageId?: string | null;
			fromKind?: string | null;
			toKind?: string | null;
			reason?: string | null;
			metadata?: Record<string, unknown>;
		}
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO quote_events (holding_id, quote_id, type, from_stage_id, to_stage_id, from_kind, to_kind, actor_id, reason, metadata)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
			[
				input.holdingId,
				input.quoteId,
				input.type,
				input.fromStageId ?? null,
				input.toStageId ?? null,
				input.fromKind ?? null,
				input.toKind ?? null,
				input.userId,
				input.reason ?? null,
				JSON.stringify({ source: 'api_v2', ...(input.metadata ?? {}) }),
			]
		)) as Row[];

		return String(row.id);
	}

	// ---------------------------------------------------------------- editar

	/** Snapshot comparable de un ítem guardado (antes de editar). */
	private static storedSnapshot(row: Row): QuoteItemSnapshot {
		return {
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			quantity: toNullableNumber(row.quantity),
			unit_price: toNullableNumber(row.unit_price),
			annual_unit_price: toNullableNumber(row.annual_unit_price),
			price_entry_mode: toText(row.price_entry_mode) ?? 'monthly',
			discount_value: toNullableNumber(row.discount_value),
			final_price: toNullableNumber(row.final_price),
			start_date: isoDate(row.start_date),
			end_date: isoDate(row.end_date),
			term_months: toNullableNumber(row.term_months),
			billing_frequency: toText(row.billing_frequency),
			billing_method: toText(row.billing_method),
			is_recurring: row.is_recurring !== false,
			price_id: toText(row.price_id),
		};
	}

	/** Snapshot del ítem resuelto (después de editar), con los mismos campos que `storedSnapshot`. */
	private static resolvedSnapshot(item: ResolvedQuoteItem, priceId: string | null): QuoteItemSnapshot {
		return {
			product_id: item.dto.product_id,
			product_name: item.product_name,
			quantity: item.dto.quantity,
			unit_price: item.unit_price,
			annual_unit_price: item.annual_unit_price,
			price_entry_mode: item.price_entry_mode,
			discount_value: item.discount_pct,
			final_price: item.final_price,
			start_date: item.dto.start_date ?? null,
			end_date: item.end_date,
			term_months: item.dto.term_months ?? null,
			billing_frequency: item.dto.billing_frequency,
			billing_method: item.dto.billing_method,
			is_recurring: item.is_recurring,
			price_id: priceId,
		};
	}

	/** Con contrato (vínculo creado/aplicado o etapa de kind `contract_created`) la cotización no se edita ni se mueve (Domi 02-10). */
	private static editLocked(kind: QuoteStageKind, hasContract: boolean): boolean {
		return hasContract || kind === 'contract_created';
	}

	/**
	 * Bloquea la cotización y devuelve su estado (§5a, Domi 02-10): se edita en cualquier etapa salvo con contrato (409
	 * `quote_has_contract`); en `signed`/`lost` exige `confirm_edit_after_signature: true` (409 `edit_requires_confirmation`).
	 */
	private async lockEditable(runner: QueryRunner, quoteId: string, holdingId: string, today: string, confirmed: boolean): Promise<Row> {
		const row = await this.loadRow(runner, quoteId, holdingId, today, true);
		const kind = (toText(row.kind) ?? 'draft') as QuoteStageKind;
		const hasContract = Boolean(row.contract_id || row.applied_contract_id);

		if (QuotesService.editLocked(kind, hasContract)) {
			throw conflict(
				'quote_has_contract',
				hasContract
					? `La cotización ya tiene un contrato (${toText(row.contract_number) ?? toText(row.applied_contract_number) ?? 'sin número'}): no se edita`
					: 'La cotización está en "Contrato creado": no se edita'
			);
		}
		if (EDIT_CONFIRMATION_STAGE_KINDS.includes(kind) && !confirmed) {
			throw conflict(
				'edit_requires_confirmation',
				`La cotización está ${kind === 'signed' ? 'firmada' : 'perdida'}: confirma que quieres editarla (el cambio queda en el historial con el detalle)`
			);
		}

		return row;
	}

	/**
	 * `PUT /quotes/:id` (cualquier etapa sin contrato; firmada/perdida con `confirm_edit_after_signature`): reemplaza el encabezado e ítems en **una transacción**. Los ítems con
	 * `id` se actualizan (conservan el id que referencian `contract_items.quote_item_id`), sin `id` se crean, los ausentes se
	 * eliminan (409 `item_linked_to_contract` si un contrato los referencia). Recalcula precio, final, mensual, período y total.
	 * Conserva número, origen SF, etapa y fecha de creación; deja el evento `UPDATED` con el diff campo a campo (`changes`, `item_changes`)
	 * y, en firmada/perdida, `edited_after_signature: true`.
	 */
	async update(quoteId: string, dto: UpdateQuoteDto, holdingId: string, authId: string, now = new Date()) {
		const today = todayIso(now);
		const userId = await resolveUserId(this.dataSource, authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		try {
			const current = await this.lockEditable(runner, quoteId, holdingId, today, dto.confirm_edit_after_signature === true);
			const currentKind = (toText(current.kind) ?? 'draft') as QuoteStageKind;
			const context = await this.loadContext(runner, dto, holdingId);
			const existing = (await runner.query(
				`SELECT qi.id, qi.price_id, p.version AS price_version, ${PRICE_COLUMNS},
					qi.product_id, qi.product_name, qi.quantity, qi.unit_price, qi.annual_unit_price, qi.price_entry_mode, qi.discount_value,
					qi.final_price, qi.start_date::text AS start_date, qi.end_date::text AS end_date, qi.term_months, qi.billing_frequency,
					qi.billing_method, qi.is_recurring,
					(SELECT c.contract_number FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
						WHERE ci.quote_item_id = qi.id AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 1) AS linked_contract_number
				FROM quote_items qi LEFT JOIN prices p ON p.id = qi.price_id
				WHERE qi.quote_id = $1 AND qi.holding_id = $2`,
				[quoteId, holdingId]
			)) as Row[];
			const existingById = new Map(existing.map((row) => [String(row.id), row]));
			const errors: FieldError[] = [];

			dto.items.forEach((item, index) => {
				if (item.id && !existingById.has(item.id))
					errors.push({ field: `items.${index}.id`, message: 'El ítem no pertenece a la cotización' });
			});
			if (errors.length) throw validationException(errors);
			const keep = new Set(dto.items.map((item) => item.id).filter((id): id is string => Boolean(id)));
			const toDelete = existing.filter((row) => !keep.has(String(row.id)));
			const linked = toDelete.find((row) => row.linked_contract_number);

			if (linked) {
				throw conflict(
					'item_linked_to_contract',
					`No se puede quitar un ítem que ya está en el contrato ${String(linked.linked_contract_number)}`,
					{
						item_id: String(linked.id),
					}
				);
			}
			const resolved = resolveQuoteItems(QuotesService.withCatalogPrices(dto, context), context.products);
			const header = QuotesService.headerValues(dto, context, resolved, now);
			const updated: string[] = [];
			const inserted: string[] = [];
			const priceChanges: Array<{ item_id: string; from: string | null; to: string | null }> = [];

			for (const item of resolved) {
				const id = (item.dto as UpdateQuoteDto['items'][number]).id;

				if (!id) {
					inserted.push(...(await this.insertItems(runner, quoteId, holdingId, dto.currency, [item], userId, context)));
					continue;
				}
				const row = existingById.get(id)!;

				await runner.query(
					`UPDATE quote_items SET
						product_id = $3, product_name = $4, account = $5, item_type = $6, unit_of_measure = $7, quantity = $8, unit_price = $9,
						annual_unit_price = $10, price_entry_mode = $11, discount_type = $12, discount_value = $13, price = $14, final_price = $15,
						monthly_price = $16, billing_period_price = $17, currency = $18, billing_frequency = $19, billing_method = $20,
						start_date = $21::date, end_date = $22::date, term_months = $23, is_recurring = $24, auto_renew = $25, auto_renew_term_months = $26,
						custom_fields = $27::jsonb, annual_price = $28
					WHERE id = $1 AND holding_id = $2`,
					[id, holdingId, ...QuotesService.itemValues(item, dto.currency)]
				);
				updated.push(id);
				const previous = row.price_id ? priceSpecFromRow(row) : null;

				if (item.price_spec && !samePriceSpec(previous, item.price_spec)) {
					const priceId = await this.insertPrice(runner, {
						quoteId,
						holdingId,
						itemId: id,
						item,
						currency: dto.currency,
						userId,
						listPriceId: item.dto.price_id ?? null,
						context,
						supersedes: row.price_id ? { id: String(row.price_id), version: toNumber(row.price_version) || 1 } : null,
					});

					priceChanges.push({ item_id: id, from: toText(row.price_id), to: priceId });
				} else if (!item.price_spec && row.price_id) {
					await runner.query(`UPDATE quote_items SET price_id = NULL WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
					await this.archivePrices(runner, [String(row.price_id)], holdingId, userId);
					priceChanges.push({ item_id: id, from: String(row.price_id), to: null });
				}
			}
			if (toDelete.length) {
				await runner.query(`DELETE FROM quote_items WHERE id = ANY($1::uuid[]) AND quote_id = $2 AND holding_id = $3`, [
					toDelete.map((row) => String(row.id)),
					quoteId,
					holdingId,
				]);
				await this.archivePrices(
					runner,
					toDelete.map((row) => toText(row.price_id)).filter((id): id is string => Boolean(id)),
					holdingId,
					userId
				);
			}
			const bookingDate = dto.booking_date === undefined ? isoDate(current.booking_date) : dto.booking_date;
			const afterHeader: Record<string, DiffValue> = {
				client_id: context.client.id,
				client_contact_id: dto.client_contact_id ?? null,
				seller_id: dto.seller_id ?? null,
				quote_type: dto.quote_type,
				quote_date: header.quoteDate,
				valid_until: header.validUntil,
				booking_date: bookingDate,
				currency: dto.currency,
				total_amount: header.totals.total_amount,
				payment_terms: header.termsText,
				notes: dto.notes ?? null,
				requires_multicompany: dto.requires_multicompany === true,
				requires_multicurrency: dto.requires_multicurrency === true,
				requires_references_for_billing: dto.requires_references_for_billing === true,
				requires_contract_document: dto.requires_contract_document === true,
			};
			const beforeHeader: Record<string, DiffValue> = {
				client_id: toText(current.client_id),
				client_contact_id: toText(current.client_contact_id),
				seller_id: toText(current.seller_id),
				quote_type: normalizeQuoteType(toText(current.quote_type)) ?? toText(current.quote_type),
				quote_date: isoDate(current.quote_date),
				valid_until: isoDate(current.valid_until),
				booking_date: isoDate(current.booking_date),
				currency: toText(current.currency),
				total_amount: toNumber(current.total_amount),
				payment_terms: toText(current.payment_terms),
				notes: toText(current.notes),
				requires_multicompany: current.requires_multicompany === true,
				requires_multicurrency: current.requires_multicurrency === true,
				requires_references_for_billing: current.requires_references_for_billing === true,
				requires_contract_document: current.requires_contract_document === true,
			};
			const changes = headerChanges(beforeHeader, afterHeader, {
				client_id: { before: toText(current.client_name), after: context.client.name },
				client_contact_id: { before: toText(current.contact_name), after: context.contactName },
				seller_id: { before: toText(current.seller_name), after: context.sellerName },
			});
			const priceChangeByItem = new Map(priceChanges.map((change) => [change.item_id, change.to]));
			let insertedIndex = 0;
			const item_changes = itemChanges(
				new Map(existing.map((row) => [String(row.id), QuotesService.storedSnapshot(row)])),
				resolved.map((item) => {
					const id = (item.dto as UpdateQuoteDto['items'][number]).id ?? null;
					const previous = id ? existingById.get(id) : undefined;
					const priceId = id && priceChangeByItem.has(id) ? (priceChangeByItem.get(id) ?? null) : toText(previous?.price_id);

					// Los nuevos se insertaron en el mismo orden: `inserted[n]` es el id del n-ésimo ítem sin id.
					return { id: id ?? inserted[insertedIndex++] ?? null, snapshot: QuotesService.resolvedSnapshot(item, priceId) };
				})
			);

			// Quién editó queda en el evento `UPDATED`; `updated_at` lo pone el trigger `quotes_set_updated_at`.
			await runner.query(
				`UPDATE quotes SET
					client_id = $3, client_contact_id = $4, seller_id = $5, quote_type = $6, quote_date = $7::date, valid_until = $8::date,
					booking_date = $9::date, currency = $10, total_amount = $11, payment_terms = $12, notes = $13,
					requires_multicompany = $14, requires_multicurrency = $15, requires_references_for_billing = $16, requires_contract_document = $17
				WHERE id = $1 AND holding_id = $2`,
				[
					quoteId,
					holdingId,
					context.client.id,
					dto.client_contact_id ?? null,
					dto.seller_id ?? null,
					dto.quote_type,
					header.quoteDate,
					header.validUntil,
					bookingDate,
					dto.currency,
					header.totals.total_amount,
					header.termsText,
					dto.notes ?? null,
					dto.requires_multicompany === true,
					dto.requires_multicurrency === true,
					dto.requires_references_for_billing === true,
					dto.requires_contract_document === true,
				]
			);
			await this.insertEvent(runner, {
				quoteId,
				holdingId,
				type: 'UPDATED',
				userId,
				fromStageId: toText(current.stage_id),
				toStageId: toText(current.stage_id),
				fromKind: toText(current.kind),
				toKind: toText(current.kind),
				metadata: {
					items: { updated, inserted, deleted: toDelete.map((row) => String(row.id)) },
					price_changes: priceChanges,
					total_amount: { from: toNumber(current.total_amount), to: header.totals.total_amount },
					currency: dto.currency,
					/** Diff campo a campo (Domi 02-10): encabezado y por ítem (agregado, quitado, cambiado) con antes/después. */
					changes,
					item_changes,
					...(EDIT_CONFIRMATION_STAGE_KINDS.includes(currentKind) ? { edited_after_signature: true, stage_kind: currentKind } : {}),
				},
			});
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.detail(quoteId, holdingId, now);
	}

	// ---------------------------------------------------------------- duplicar (Q-A6)

	/** `POST /quotes/:id/duplicate`: borrador nuevo con correlativo propio, sin datos de Salesforce ni booking; copia ítems y precios. */
	async duplicate(quoteId: string, dto: DuplicateQuoteDto, holdingId: string, authId: string, now = new Date()) {
		const today = todayIso(now);
		const userId = await resolveUserId(this.dataSource, authId);
		const source = await this.form(quoteId, holdingId, now);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		let newId: string;

		try {
			const quoteDate = dto.quote_date ?? today;
			const body: CreateQuoteDto = {
				...(source.form as unknown as CreateQuoteDto),
				quote_type: (source.form.quote_type ?? 'new_business') as CreateQuoteDto['quote_type'],
				quote_date: quoteDate,
				valid_until: addDays(quoteDate, DEFAULT_VALID_DAYS),
				booking_date: null,
				payment_terms: (source.form.payment_terms as CreateQuoteDto['payment_terms']) ?? null,
				items: source.form.items.map((item) => {
					const copy: Record<string, unknown> = { ...item, product_id: String(item.product_id ?? '') };

					// La copia nace sin ids ni vínculos: los ítems se insertan de nuevo.
					delete copy.id;
					delete copy.linked_contract;
					delete copy.discount_fixed_amount;

					return copy as unknown as CreateQuoteItemDto;
				}),
			};

			delete (body as Partial<CreateQuoteDto>).quote_number;
			const context = await this.loadContext(runner, body, holdingId);

			if (!context.draftStage)
				throw conflict('stage_kind_missing', 'El holding no tiene una etapa de tipo borrador (kind draft): configúrala en Etapas');
			const resolved = resolveQuoteItems(body.items, context.products);
			const header = QuotesService.headerValues(body, context, resolved, now);
			const quoteNumber = await this.reserveNumber(runner, dto.quote_number, holdingId, now);

			newId = await this.insertQuote(runner, {
				holdingId,
				dto: body,
				context,
				header,
				quoteNumber,
				stageId: context.draftStage.id,
				salesforceOpportunityId: null,
			});
			const itemIds = await this.insertItems(runner, newId, holdingId, body.currency, resolved, userId, context);

			await this.insertEvent(runner, {
				quoteId: newId,
				holdingId,
				type: 'DUPLICATED_FROM',
				toStageId: context.draftStage.id,
				toKind: 'draft',
				userId,
				metadata: { source_quote_id: quoteId, source_quote_number: source.quote_number, quote_number: quoteNumber, items: itemIds },
			});
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.detail(newId, holdingId, now);
	}

	// ---------------------------------------------------------------- eliminar (Q-A5)

	/** `DELETE /quotes/:id`: borrado lógico solo en `draft`/`sent`/`lost` sin contrato (409 `quote_not_deletable`); deja el evento `DELETED`. */
	async remove(quoteId: string, holdingId: string, authId: string, now = new Date()) {
		const today = todayIso(now);
		const userId = await resolveUserId(this.dataSource, authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		try {
			const row = await this.loadRow(runner, quoteId, holdingId, today, true);
			const kind = (toText(row.kind) ?? 'draft') as QuoteStageKind;

			if (row.contract_id || row.applied_contract_id || !DELETABLE_STAGE_KINDS.includes(kind)) {
				const status = (toText(row.derived_status) ?? 'draft') as QuoteDerivedStatus;

				throw conflict('quote_not_deletable', `Una cotización ${QUOTE_STATUS_LABELS[status].toLowerCase()} no se elimina`);
			}
			await runner.query(`UPDATE quotes SET deleted_at = now() WHERE id = $1 AND holding_id = $2`, [quoteId, holdingId]);
			await this.insertEvent(runner, {
				quoteId,
				holdingId,
				type: 'DELETED',
				userId,
				fromStageId: toText(row.stage_id),
				fromKind: kind,
				metadata: { quote_number: toText(row.quote_number) },
			});
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return { id: quoteId, deleted: true };
	}

	// ---------------------------------------------------------------- transiciones (§5a)

	/**
	 * `POST /quotes/:id/stage` `{ stage_id | kind, booking_date?, reason? }`: valida la transición entre kinds (`transitionError`: libre
	 * entre draft/sent/signed/lost, nada con contract_created ni con contrato), exige ítems completos y booking al firmar, motivo al
	 * perder; conserva `booking_date` salvo que venga en el body; escribe solo etapa y booking (la línea de vida —`sent_at`, `lost_at`,
	 * motivo, actor— es el evento; `updated_at` lo pone el trigger).
	 */
	async transition(quoteId: string, dto: QuoteStageTransitionDto, holdingId: string, authId: string, now = new Date()) {
		const today = todayIso(now);
		const userId = await resolveUserId(this.dataSource, authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		try {
			const row = await this.loadRow(runner, quoteId, holdingId, today, true);
			const fromKind = (toText(row.kind) ?? 'draft') as QuoteStageKind;
			const hasContract = Boolean(row.contract_id || row.applied_contract_id);
			const target = await this.resolveTargetStage(runner, dto, holdingId);
			const toKind = target.kind;
			const error = transitionError(fromKind, toKind, hasContract);

			if (error === 'quote_has_contract') {
				throw conflict(
					error,
					`La cotización ya tiene un contrato (${toText(row.contract_number) ?? toText(row.applied_contract_number) ?? 'sin número'})`
				);
			}
			if (error) throw conflict(error, `No se puede pasar de ${QUOTE_STATUS_LABELS[fromKind]} a ${QUOTE_STATUS_LABELS[toKind]}`);
			// Salir de firmada/perdida no limpia nada en silencio: `booking_date` se conserva salvo que el usuario la cambie (Domi 02-10).
			const bookingDate = dto.booking_date ?? isoDate(row.booking_date);

			if (toKind === 'signed') {
				const items = (await runner.query(
					`SELECT id, product_id, product_name, final_price, start_date::text AS start_date, end_date::text AS end_date, term_months,
						billing_frequency, billing_method, price_id
					FROM quote_items WHERE quote_id = $1 AND holding_id = $2 ORDER BY product_name, id`,
					[quoteId, holdingId]
				)) as unknown as StoredQuoteItem[];
				const incomplete = itemsIncomplete(items);

				if (!items.length) incomplete.push({ field: 'items', message: 'La cotización no tiene ítems' });
				if (incomplete.length) throw conflict('items_incomplete', 'Completa los ítems antes de marcar firmada', { errors: incomplete });
				if (!bookingDate) throw conflict('booking_date_required', 'Indica la fecha de cierre del negocio (booking)');
			}
			if (toKind === 'lost' && !dto.reason?.trim()) throw validationException([{ field: 'reason', message: 'Indica el motivo de la pérdida' }]);
			await runner.query(`UPDATE quotes SET quote_stage_id = $3, booking_date = $4::date WHERE id = $1 AND holding_id = $2`, [
				quoteId,
				holdingId,
				target.id,
				bookingDate,
			]);
			await this.insertEvent(runner, {
				quoteId,
				holdingId,
				type: transitionEventType(fromKind, toKind),
				userId,
				fromStageId: toText(row.stage_id),
				toStageId: target.id,
				fromKind,
				toKind,
				reason: dto.reason?.trim() ?? null,
				metadata: {
					from_stage: toText(row.stage_name),
					to_stage: target.name,
					booking_date: bookingDate,
					...(bookingDate !== isoDate(row.booking_date) ? { booking_date_before: isoDate(row.booking_date) } : {}),
				},
			});
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.detail(quoteId, holdingId, now);
	}

	/** Etapa destino por `stage_id` (del holding) o por `kind` (primera del holding con ese kind); 409 `stage_kind_mismatch` si no calza. */
	private async resolveTargetStage(
		runner: Queryable,
		dto: QuoteStageTransitionDto,
		holdingId: string
	): Promise<{ id: string; name: string; kind: QuoteStageKind }> {
		const rows = (await runner.query(
			dto.stage_id
				? `SELECT id, name, kind FROM quote_stages WHERE holding_id = $1 AND id = $2 LIMIT 1`
				: `SELECT id, name, kind FROM quote_stages WHERE holding_id = $1 AND kind = $2 ORDER BY position, name LIMIT 1`,
			[holdingId, dto.stage_id ?? dto.kind]
		)) as Row[];
		const [stage] = rows;

		if (!stage) {
			if (dto.stage_id) throw validationException([{ field: 'stage_id', message: 'La etapa no existe en el holding' }]);
			throw conflict('stage_kind_mismatch', `El holding no tiene una etapa de tipo "${dto.kind}": configúrala en Etapas`);
		}
		const kind = isStageKind(stage.kind) ? stage.kind : 'draft';

		if (dto.kind && dto.stage_id && kind !== dto.kind)
			throw conflict('stage_kind_mismatch', `La etapa "${String(stage.name)}" es de tipo ${kind}, no ${dto.kind}`);

		return { id: String(stage.id), name: String(stage.name), kind };
	}

	// ---------------------------------------------------------------- costura con Contratos

	/**
	 * `POST /quotes/:id/contract`: mismo body que `POST /contracts` (la BFF lo arma con `GET /contracts/from-quote/:id`); exige que la
	 * cotización esté firmada y sin contrato, y delega en `ContractDraftsService.create` con `quote_id` fijo (Contratos marca la etapa
	 * "Contrato creado" y deja el evento en su transacción). Devuelve el contrato 360.
	 */
	async createContract(quoteId: string, body: CreateContractDto, holdingId: string, authId: string, now = new Date()) {
		const row = await this.loadRow(this.dataSource, quoteId, holdingId, todayIso(now));
		const status = deriveQuoteStatus(
			{ kind: toText(row.kind), valid_until: toText(row.valid_until), has_contract: Boolean(row.contract_id || row.applied_contract_id) },
			todayIso(now)
		);

		if (status === 'contract_created') {
			throw conflict(
				'quote_already_applied',
				`La cotización ya tiene un contrato (${toText(row.contract_number) ?? toText(row.applied_contract_number) ?? 'sin número'})`
			);
		}
		if (status !== 'signed') throw conflict('quote_not_signed', 'Solo una cotización firmada genera un contrato: márcala firmada primero');

		return await this.contractDrafts.create({ ...body, quote_id: quoteId }, holdingId, authId, now);
	}

	/**
	 * `GET /quotes/:id/contract-targets`: contratos Activos (vigentes o Por renovar) del cliente de la cotización donde puede aplicarse con
	 * `POST /contracts/:id/changes` (`origin { type: 'quote', quote_id }`), con la sugerencia por ítem cotizado (`item_change` si el producto
	 * ya está vivo, `item_add` si es nuevo), bloqueos y avisos (`contractTargetsOf`).
	 */
	async contractTargets(quoteId: string, holdingId: string, now = new Date()): Promise<{ data: ContractTarget[] }> {
		const today = todayIso(now);
		const row = await this.loadRow(this.dataSource, quoteId, holdingId, today);
		const status = deriveQuoteStatus(
			{ kind: toText(row.kind), valid_until: toText(row.valid_until), has_contract: Boolean(row.contract_id || row.applied_contract_id) },
			today
		);
		const clientId = toText(row.client_id);

		if (!clientId) return { data: [] };
		const [quoteItems, contracts] = await Promise.all([
			this.loadItems(this.dataSource, quoteId, holdingId),
			this.dataSource.query<Row[]>(
				`SELECT c.id, c.contract_number, c.contract_currency, COALESCE(c.requires_multicurrency_billing, false) AS requires_multicurrency_billing,
					ds.derived_status, nx.next_item_end_date::text AS next_item_end_date,
					COALESCE((SELECT SUM(ci.monthly_price) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.is_recurring = true
						AND ci.churn_date IS NULL AND ci.renewed_by_item_id IS NULL AND ci.start_date <= $3::date
						AND (ci.end_date IS NULL OR ci.end_date >= $3::date)), 0) AS mrr
				FROM contracts c
				${NEXT_ITEM_END_LATERAL.replace(/\$2::date/g, '$3::date')}
				${derivedStatusLateral('$3')}
				WHERE c.client_id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL AND c.status = 'Activo'
				ORDER BY c.contract_number`,
				[clientId, holdingId, today]
			),
		]);
		const open = contracts.filter((contract) => ['active', 'pending_renewal'].includes(toText(contract.derived_status) ?? ''));
		const items = open.length
			? await this.dataSource.query<Row[]>(
					`SELECT ci.contract_id, ci.id, ci.product_id, ci.product_name, ci.account, ci.quantity, ci.unit_price, ci.monthly_price, ci.currency
					FROM contract_items ci
					WHERE ci.contract_id = ANY($1::uuid[]) AND ci.holding_id = $2 AND ci.is_recurring = true AND ci.churn_date IS NULL
						AND ci.renewed_by_item_id IS NULL AND ci.related_item_id IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
						AND (ci.end_date IS NULL OR ci.end_date >= $3::date)
					ORDER BY ci.start_date, ci.id`,
					[open.map((contract) => String(contract.id)), holdingId, today]
				)
			: [];

		return {
			data: contractTargetsOf(
				{ id: quoteId, status, quote_type: toText(row.quote_type), currency: toText(row.currency) },
				quoteItems.map((item) => ({
					id: String(item.id),
					product_id: toText(item.product_id),
					product_name: toText(item.product_name),
					account: toText(item.account),
					quantity: toNullableNumber(item.quantity),
					unit_price:
						toText(item.price_entry_mode) === 'annual' ? toNumber(item.annual_unit_price) / 12 : toNullableNumber(item.unit_price),
					currency: toText(item.currency),
					is_recurring: item.is_recurring !== false,
				})),
				open.map((contract) => ({
					id: String(contract.id),
					contract_number: toText(contract.contract_number),
					derived_status: toText(contract.derived_status) ?? 'active',
					contract_currency: toText(contract.contract_currency),
					requires_multicurrency_billing: contract.requires_multicurrency_billing === true,
					next_item_end_date: toText(contract.next_item_end_date),
					mrr: toNumber(contract.mrr),
				})),
				items.map((item) => ({
					contract_id: String(item.contract_id),
					id: String(item.id),
					product_id: toText(item.product_id),
					product_name: toText(item.product_name),
					account: toText(item.account),
					quantity: toNullableNumber(item.quantity),
					unit_price: toNullableNumber(item.unit_price),
					monthly_price: toNullableNumber(item.monthly_price),
					currency: toText(item.currency),
				}))
			),
		};
	}
}

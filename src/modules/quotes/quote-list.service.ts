import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { parsePaymentTermsText } from '@/modules/contracts/contract-drafts.service';

import {
	normalizeQuoteType,
	QUOTE_CONTRACT_LATERAL,
	QUOTE_DERIVED_STATUSES,
	QUOTE_STATUS_LABELS,
	QUOTE_TYPE_CODES,
	QUOTE_TYPE_SYNONYMS,
	type QuoteDerivedStatus,
	quoteStatusLateral,
	type QuoteTypeCode,
	quoteTypeLabel,
} from './quote-status';

import type { QueryQuotesDto, QuoteSortField } from './dtos/query-quotes.dto';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toText = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

/** Borrado lógico (Q-A5): una cotización borrada no aparece en ninguna lectura v2. */
export const QUOTE_NOT_DELETED = `q.deleted_at IS NULL`;

/** Estado mostrado (lateral `ds`). `$2` = hoy. */
const STATUS_LATERAL = quoteStatusLateral('$2');

/** MRR cotizado = Σ `monthly_price` de los ítems recurrentes; conteo y productos (hasta 5) de la cotización. */
const ITEMS_LATERAL = `LEFT JOIN LATERAL (
	SELECT COUNT(*) AS items_count,
		COALESCE(SUM(qi.monthly_price) FILTER (WHERE qi.is_recurring = true), 0) AS mrr,
		(SELECT array_agg(p.product_name ORDER BY p.product_name) FROM (
			SELECT DISTINCT x.product_name FROM quote_items x WHERE x.quote_id = q.id AND x.product_name IS NOT NULL ORDER BY x.product_name LIMIT 5
		) p) AS products
	FROM quote_items qi
	WHERE qi.quote_id = q.id
) it ON true`;

/**
 * Línea de vida y actores derivados de `quote_events` (lateral `ev`; nada de esto se guarda en `quotes`): `sent_at` = último `SENT`,
 * `lost_at`/`lost_reason` = último `LOST`, `created_by` = actor del `CREATED`, `updated_by` = actor del último evento con usuario.
 * Necesita `q` (quotes) en el FROM. `signed_at` no vive aquí: es `booking_date` cuando la cotización está firmada (`ROW_COLUMNS`).
 */
export const QUOTE_EVENTS_LATERAL = `LEFT JOIN LATERAL (
	SELECT sent.created_at AS sent_at, lost.created_at AS lost_at, lost.reason AS lost_reason,
		created.actor_id AS created_by_id, COALESCE(cu.name, cu.email) AS created_by_name,
		last.actor_id AS updated_by_id, COALESCE(uu.name, uu.email) AS updated_by_name
	FROM (SELECT 1) AS one
	LEFT JOIN LATERAL (SELECT e.created_at FROM quote_events e WHERE e.quote_id = q.id AND e.type = 'SENT' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) sent ON true
	LEFT JOIN LATERAL (SELECT e.created_at, e.reason FROM quote_events e WHERE e.quote_id = q.id AND e.type = 'LOST' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) lost ON true
	LEFT JOIN LATERAL (SELECT e.actor_id FROM quote_events e WHERE e.quote_id = q.id AND e.type = 'CREATED' ORDER BY e.created_at, e.id LIMIT 1) created ON true
	LEFT JOIN LATERAL (SELECT e.actor_id FROM quote_events e WHERE e.quote_id = q.id AND e.actor_id IS NOT NULL ORDER BY e.created_at DESC, e.id DESC LIMIT 1) last ON true
	LEFT JOIN users cu ON cu.id = created.actor_id
	LEFT JOIN users uu ON uu.id = last.actor_id
) ev ON true`;

/** Fecha de pérdida de la cotización **hoy perdida** (reabrirla la limpia, como antes hacía la columna). */
const LOST_AT = `CASE WHEN qs.kind = 'lost' THEN ev.lost_at END`;

const FROM = `FROM quotes q
	LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
	LEFT JOIN clients cl ON cl.id = q.client_id
	LEFT JOIN client_contacts cc ON cc.id = q.client_contact_id
	LEFT JOIN sellers sl ON sl.id = q.seller_id
	${QUOTE_CONTRACT_LATERAL}
	${QUOTE_EVENTS_LATERAL}
	${ITEMS_LATERAL}
	${STATUS_LATERAL}`;

/** `open` = abiertas (draft + sent + expired). `all`/vacío = todas. */
export const parseQuoteStatusFilter = (value?: string | null): QuoteDerivedStatus[] => {
	const parts = (value ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

	if (!parts.length || parts.includes('all')) return [];
	const expanded = parts.flatMap((part) => (part === 'open' ? ['draft', 'sent', 'expired'] : [part]));

	return [...new Set(expanded.filter((part): part is QuoteDerivedStatus => (QUOTE_DERIVED_STATUSES as readonly string[]).includes(part)))];
};

/** Fila de la lista (`GET /quotes`), también usada por la vista rápida. */
export function quoteListRow(row: Row) {
	const code = normalizeQuoteType(toText(row.quote_type));
	const contract = row.contract_id
		? {
				id: String(row.contract_id),
				contract_number: toText(row.contract_number),
				status: toText(row.contract_status),
				relation: 'created' as const,
			}
		: row.applied_contract_id
			? {
					id: String(row.applied_contract_id),
					contract_number: toText(row.applied_contract_number),
					status: toText(row.applied_contract_status),
					relation: 'applied' as const,
				}
			: null;

	return {
		id: String(row.id),
		quote_number: toText(row.quote_number),
		status: (toText(row.derived_status) ?? 'draft') as QuoteDerivedStatus,
		stage: row.stage_id
			? {
					id: String(row.stage_id),
					name: toText(row.stage_name),
					color: toText(row.stage_color),
					kind: toText(row.kind),
					position: toNumber(row.stage_position),
				}
			: null,
		quote_type: code ?? toText(row.quote_type),
		quote_type_label: quoteTypeLabel(toText(row.quote_type)),
		client: row.client_id ? { id: String(row.client_id), name: toText(row.client_name), country: toText(row.client_country) } : null,
		contact: row.contact_id ? { id: String(row.contact_id), name: toText(row.contact_name) } : null,
		seller: row.seller_id ? { id: String(row.seller_id), name: toText(row.seller_name) } : null,
		currency: toText(row.currency),
		total_amount: toNumber(row.total_amount),
		mrr: Math.round(toNumber(row.mrr) * 100) / 100,
		items_count: toNumber(row.items_count),
		products: Array.isArray(row.products) ? (row.products as string[]) : [],
		quote_date: toText(row.quote_date),
		valid_until: toText(row.valid_until),
		booking_date: toText(row.booking_date),
		payment_terms: toText(row.payment_terms),
		/** Derivada del texto (Q-D4): null si el texto no se interpreta (alerta `payment_terms_unparsed`). */
		payment_terms_json: parsePaymentTermsText(row.payment_terms),
		origin: row.salesforce_opportunity_id ? ('salesforce' as const) : ('manual' as const),
		salesforce_opportunity_id: toText(row.salesforce_opportunity_id),
		contract,
		notes: toText(row.notes),
		/** Línea de vida derivada: `sent_at`/`lost_at`/`lost_reason` de `quote_events`; `signed_at` = `booking_date` si está firmada. */
		sent_at: iso(row.sent_at),
		signed_at: toText(row.signed_at),
		lost_at: iso(row.lost_at),
		lost_reason: toText(row.lost_reason),
		created_at: iso(row.created_at),
		updated_at: iso(row.updated_at),
		created_by: row.created_by_id ? { id: String(row.created_by_id), name: toText(row.created_by_name) } : null,
		updated_by: row.updated_by_id ? { id: String(row.updated_by_id), name: toText(row.updated_by_name) } : null,
	};
}

export type QuoteListRow = ReturnType<typeof quoteListRow>;

/**
 * Cotizaciones v2 — lista, KPIs y opciones de filtro (mapa §5b y §6). Solo lee y siempre acota al holding del guard. El estado
 * mostrado se calcula al leer con el mismo lateral en filas, conteos y KPIs (`quote-status.ts`).
 */
@Injectable()
export class QuoteListService {
	constructor(private readonly dataSource: DataSource) {}

	/** Columnas de una fila de la lista; `$2` = hoy. Necesita `ev` (`QUOTE_EVENTS_LATERAL`) y `ds` (estado) en el FROM. */
	static readonly ROW_COLUMNS = `q.id, q.quote_number, q.quote_type, q.currency, q.total_amount, q.payment_terms, q.notes,
		q.quote_date::text AS quote_date, q.valid_until::text AS valid_until, q.booking_date::text AS booking_date,
		q.salesforce_opportunity_id, q.created_at, q.updated_at,
		ev.sent_at, ${LOST_AT} AS lost_at, CASE WHEN qs.kind = 'lost' THEN ev.lost_reason END AS lost_reason,
		CASE WHEN ds.derived_status IN ('signed', 'contract_created') THEN q.booking_date::text END AS signed_at,
		ev.created_by_id, ev.created_by_name, ev.updated_by_id, ev.updated_by_name,
		ds.kind, ds.derived_status,
		qs.id AS stage_id, qs.name AS stage_name, qs.color AS stage_color, qs.position AS stage_position,
		q.client_id, cl.name_commercial AS client_name, cl.country AS client_country,
		cc.id AS contact_id, cc.name AS contact_name, sl.id AS seller_id, sl.name AS seller_name,
		it.items_count, it.mrr, COALESCE(it.products, '{}') AS products,
		ct.id AS contract_id, ct.contract_number, ct.status AS contract_status,
		ap.contract_id AS applied_contract_id, ap.contract_number AS applied_contract_number, ap.status AS applied_contract_status`;

	/**
	 * Búsqueda (`$n` = `%texto%`): número, cliente comercial, RUT/tax id de sus razones sociales (sin puntos, guiones ni espacios de
	 * ambos lados), producto de cualquier ítem y oportunidad SF (mismo criterio que `GET /contracts`).
	 */
	static searchCondition(n: number): string {
		const strip = (expression: string) => `regexp_replace(${expression}, '[.[:space:]-]', '', 'g')`;

		return `(q.quote_number ILIKE $${n} OR cl.name_commercial ILIKE $${n} OR q.salesforce_opportunity_id ILIKE $${n}
			OR EXISTS (SELECT 1 FROM quote_items si WHERE si.quote_id = q.id AND si.product_name ILIKE $${n})
			OR (${strip(`$${n}`)} <> '%%' AND EXISTS (
				SELECT 1 FROM client_entities ce
				WHERE ce.holding_id = q.holding_id AND ${strip('ce.tax_id')} ILIKE ${strip(`$${n}`)}
					AND (ce.client_id = q.client_id OR EXISTS (
						SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = q.client_id AND x.holding_id = q.holding_id)))))`;
	}

	/** WHERE compartido por lista, conteos, totales y KPIs. Devuelve el arreglo de condiciones (sin el estado) y los `params`. */
	private buildWhere(holdingId: string, filters: QueryQuotesDto, today: string) {
		const params: unknown[] = [holdingId, today];
		const where = [`q.holding_id = $1`, QUOTE_NOT_DELETED];
		const list = (value?: string) =>
			(value ?? '')
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean);
		const has = (value: unknown) => value !== undefined && value !== null && value !== '';

		if (filters.clientId) where.push(`q.client_id = ANY($${params.push(list(filters.clientId))}::uuid[])`);
		if (filters.entityId) {
			const n = params.push(list(filters.entityId));

			where.push(`EXISTS (SELECT 1 FROM client_entities ce WHERE ce.id = ANY($${n}::uuid[]) AND ce.holding_id = q.holding_id
				AND (ce.client_id = q.client_id OR EXISTS (
					SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = q.client_id AND x.holding_id = q.holding_id)))`);
		}
		if (filters.sellerId) where.push(`q.seller_id = ANY($${params.push(list(filters.sellerId))}::uuid[])`);
		if (filters.stageId) where.push(`q.quote_stage_id = ANY($${params.push(list(filters.stageId))}::uuid[])`);
		if (filters.kind) where.push(`ds.kind = ANY($${params.push(list(filters.kind))}::text[])`);
		if (filters.currency?.trim())
			where.push(`upper(q.currency) = ANY($${params.push(list(filters.currency).map((code) => code.toUpperCase()))}::text[])`);
		if (filters.quoteType) {
			// Códigos y sus grafías viejas (Q-A9): el filtro cubre datos nuevos y viejos.
			const codes = list(filters.quoteType).filter((code): code is QuoteTypeCode => (QUOTE_TYPE_CODES as readonly string[]).includes(code));
			const values = [...new Set(codes.flatMap((code) => QUOTE_TYPE_SYNONYMS[code]).map((value) => value.toLowerCase()))];

			where.push(`lower(COALESCE(q.quote_type, '')) = ANY($${params.push(values)}::text[])`);
		}
		if (filters.productId)
			where.push(
				`EXISTS (SELECT 1 FROM quote_items pi WHERE pi.quote_id = q.id AND pi.product_id = ANY($${params.push(list(filters.productId))}::uuid[]))`
			);
		if (filters.clientCountry?.trim()) where.push(`cl.country = ANY($${params.push(list(filters.clientCountry))}::text[])`);
		if (filters.origin === 'salesforce') where.push(`q.salesforce_opportunity_id IS NOT NULL`);
		if (filters.origin === 'manual') where.push(`q.salesforce_opportunity_id IS NULL`);
		if (has(filters.hasContract)) where.push(`${filters.hasContract === 'true' ? '' : 'NOT '}(ct.id IS NOT NULL OR ap.contract_id IS NOT NULL)`);
		if (filters.validUntilFrom) where.push(`q.valid_until >= $${params.push(filters.validUntilFrom)}::date`);
		if (filters.validUntilTo) where.push(`q.valid_until <= $${params.push(filters.validUntilTo)}::date`);
		if (filters.bookingFrom) where.push(`q.booking_date >= $${params.push(filters.bookingFrom)}::date`);
		if (filters.bookingTo) where.push(`q.booking_date <= $${params.push(filters.bookingTo)}::date`);
		if (filters.quoteDateFrom) where.push(`q.quote_date >= $${params.push(filters.quoteDateFrom)}::date`);
		if (filters.quoteDateTo) where.push(`q.quote_date <= $${params.push(filters.quoteDateTo)}::date`);
		if (filters.createdFrom) where.push(`q.created_at >= $${params.push(filters.createdFrom)}::date`);
		if (filters.createdTo) where.push(`q.created_at < $${params.push(filters.createdTo)}::date + 1`);
		if (has(filters.amountMin)) where.push(`q.total_amount >= $${params.push(Number(filters.amountMin))}::numeric`);
		if (has(filters.amountMax)) where.push(`q.total_amount <= $${params.push(Number(filters.amountMax))}::numeric`);
		if (filters.search?.trim()) where.push(QuoteListService.searchCondition(params.push(`%${filters.search.trim()}%`)));

		return { where, params };
	}

	// ---------------------------------------------------------------- lista

	async list(holdingId: string, filters: QueryQuotesDto, asOfDate = new Date()) {
		const { page = 1, limit = 25, sortBy = 'quote_date', sortOrder = 'desc' } = filters;
		const today = isoDate(asOfDate);
		const statuses = parseQuoteStatusFilter(filters.status);
		const { where, params } = this.buildWhere(holdingId, filters, today);
		const base = `WHERE ${where.join(' AND ')}`;
		// Literales de la lista blanca (no `$n`): el conteo comparte `params` y no usa el estado.
		const statusFilter = statuses.length ? `AND ds.derived_status IN (${statuses.map((value) => `'${value}'`).join(', ')})` : '';
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn: Record<QuoteSortField, string> = {
			quote_number: 'q.quote_number',
			client_name: 'cl.name_commercial',
			status: 'ds.derived_status',
			stage: 'qs.position',
			seller: 'sl.name',
			quote_type: 'q.quote_type',
			total_amount: 'q.total_amount',
			mrr: 'it.mrr',
			currency: 'q.currency',
			quote_date: 'q.quote_date',
			booking_date: 'q.booking_date',
			valid_until: 'q.valid_until',
			created_at: 'q.created_at',
			contract: 'COALESCE(ct.contract_number, ap.contract_number)',
			items_count: 'it.items_count',
		};
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;

		const [rows, [countRow], totalsRows, [conversionRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT ${QuoteListService.ROW_COLUMNS}
				${FROM}
				${base} ${statusFilter}
				ORDER BY ${orderColumn[sortBy] ?? 'q.quote_date'} ${direction} NULLS LAST, q.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS all_count,
					${QUOTE_DERIVED_STATUSES.map((value) => `COUNT(*) FILTER (WHERE ds.derived_status = '${value}') AS ${value}_count`).join(',\n\t\t\t\t\t')}
				${FROM}
				${base}`,
				params
			),
			// Montos por moneda del conjunto filtrado (sin conversión: la cotización vive en su moneda; Supuesto).
			this.dataSource.query<Row[]>(
				`SELECT upper(COALESCE(q.currency, '')) AS currency, COUNT(*) AS quotes_count,
					COALESCE(SUM(q.total_amount) FILTER (WHERE ds.derived_status IN ('draft', 'sent', 'expired')), 0) AS open_amount,
					COALESCE(SUM(it.mrr) FILTER (WHERE ds.derived_status IN ('draft', 'sent', 'expired')), 0) AS open_mrr,
					COALESCE(SUM(q.total_amount), 0) AS total_amount, COALESCE(SUM(it.mrr), 0) AS mrr
				${FROM}
				${base} ${statusFilter}
				GROUP BY 1 ORDER BY 1`,
				params
			),
			this.dataSource.query<Row[]>(QuoteListService.conversionSql(`WHERE q.holding_id = $1 AND ${QUOTE_NOT_DELETED}`), [holdingId, today]),
		]);
		const counts = {
			all: toNumber(countRow?.all_count),
			...(Object.fromEntries(QUOTE_DERIVED_STATUSES.map((value) => [value, toNumber(countRow?.[`${value}_count`])])) as Record<
				QuoteDerivedStatus,
				number
			>),
		};
		const total = statuses.length ? statuses.reduce((sum, value) => sum + counts[value], 0) : counts.all;

		return {
			data: rows.map(quoteListRow),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			/** Por estado mostrado, con todos los filtros salvo el estado (cada pestaña muestra su total). */
			counts: { ...counts, open: counts.draft + counts.sent + counts.expired },
			/** Sobre el conjunto filtrado completo (todas las páginas, estado incluido), por moneda. */
			totals: {
				quotes: totalsRows.reduce((sum, row) => sum + toNumber(row.quotes_count), 0),
				by_currency: totalsRows.map((row) => ({
					currency: toText(row.currency),
					quotes: toNumber(row.quotes_count),
					total_amount: Math.round(toNumber(row.total_amount) * 100) / 100,
					open_amount: Math.round(toNumber(row.open_amount) * 100) / 100,
					mrr: Math.round(toNumber(row.mrr) * 100) / 100,
					open_mrr: Math.round(toNumber(row.open_mrr) * 100) / 100,
				})),
				conversion_90d: QuoteListService.conversion(conversionRow),
			},
		};
	}

	/**
	 * Conversión 90 días (§5b): firmadas + con contrato / cerradas (firmadas + con contrato + perdidas) por fecha de cierre
	 * (`booking_date` para las firmadas; el último evento `LOST` para las perdidas). `$2` = hoy.
	 */
	static conversionSql(where: string) {
		return `SELECT
			COUNT(*) FILTER (WHERE ds.derived_status IN ('signed', 'contract_created')
				AND q.booking_date BETWEEN $2::date - 90 AND $2::date) AS won,
			COUNT(*) FILTER (WHERE ds.derived_status = 'lost' AND ev.lost_at::date BETWEEN $2::date - 90 AND $2::date) AS lost
		FROM quotes q
		LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
		${QUOTE_CONTRACT_LATERAL}
		${QUOTE_EVENTS_LATERAL}
		${STATUS_LATERAL}
		${where}`;
	}

	static conversion(row: Row | undefined) {
		const won = toNumber(row?.won);
		const lost = toNumber(row?.lost);
		const closed = won + lost;

		return { won, lost, closed, rate: closed ? Math.round((won / closed) * 1000) / 10 : null };
	}

	// ---------------------------------------------------------------- KPIs

	/** KPIs de la cabecera (§5b): mismo estado mostrado que la lista, montos por moneda, conversión 90 d. */
	async summary(holdingId: string, asOfDate = new Date()) {
		const today = isoDate(asOfDate);
		const scoped = `WHERE q.holding_id = $1 AND ${QUOTE_NOT_DELETED}`;
		const [[countRow], byCurrency, [conversionRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS all_count,
					${QUOTE_DERIVED_STATUSES.map((value) => `COUNT(*) FILTER (WHERE ds.derived_status = '${value}') AS ${value}_count`).join(',\n\t\t\t\t\t')},
					COUNT(*) FILTER (WHERE ds.derived_status = 'lost' AND ev.lost_at::date >= $2::date - 90) AS lost_90d_count,
					COUNT(*) FILTER (WHERE ds.derived_status IN ('draft', 'sent') AND q.valid_until BETWEEN $2::date AND $2::date + 7) AS expiring_7d_count
				${FROM}
				${scoped}`,
				[holdingId, today]
			),
			this.dataSource.query<Row[]>(
				`SELECT upper(COALESCE(q.currency, '')) AS currency,
					COALESCE(SUM(q.total_amount) FILTER (WHERE ds.derived_status IN ('draft', 'sent', 'expired')), 0) AS open_amount,
					COALESCE(SUM(it.mrr) FILTER (WHERE ds.derived_status IN ('draft', 'sent', 'expired')), 0) AS open_mrr,
					COALESCE(SUM(q.total_amount) FILTER (WHERE ds.derived_status = 'signed'), 0) AS signed_amount
				${FROM}
				${scoped}
				GROUP BY 1 ORDER BY 1`,
				[holdingId, today]
			),
			this.dataSource.query<Row[]>(QuoteListService.conversionSql(scoped), [holdingId, today]),
		]);
		const count = (name: string) => toNumber(countRow?.[name]);

		return {
			as_of: today,
			total: count('all_count'),
			/** Abiertas = borrador + enviada + vencida. */
			open: count('draft_count') + count('sent_count') + count('expired_count'),
			draft: count('draft_count'),
			sent: count('sent_count'),
			expired: count('expired_count'),
			expiring_7d: count('expiring_7d_count'),
			/** La cola de trabajo: firmadas que todavía no tienen contrato. */
			signed_without_contract: count('signed_count'),
			contract_created: count('contract_created_count'),
			lost: count('lost_count'),
			lost_90d: count('lost_90d_count'),
			pipeline_by_currency: byCurrency.map((row) => ({
				currency: toText(row.currency),
				open_amount: Math.round(toNumber(row.open_amount) * 100) / 100,
				open_mrr: Math.round(toNumber(row.open_mrr) * 100) / 100,
				signed_amount: Math.round(toNumber(row.signed_amount) * 100) / 100,
			})),
			conversion_90d: QuoteListService.conversion(conversionRow),
		};
	}

	// ---------------------------------------------------------------- opciones de filtro

	async filterOptions(holdingId: string) {
		const scoped = `q.holding_id = $1 AND ${QUOTE_NOT_DELETED}`;
		const [stages, sellers, currencies, products, countries, types, contacts] = await Promise.all([
			this.dataSource.query<Row[]>(`SELECT id, name, color, kind, position FROM quote_stages WHERE holding_id = $1 ORDER BY position, name`, [
				holdingId,
			]),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT s.id, s.name FROM quotes q JOIN sellers s ON s.id = q.seller_id WHERE ${scoped} ORDER BY s.name`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT upper(q.currency) AS value FROM quotes q WHERE ${scoped} AND NULLIF(TRIM(q.currency), '') IS NOT NULL ORDER BY value`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT qi.product_id AS id, COALESCE(MAX(p.name), MAX(qi.product_name)) AS name
				FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id LEFT JOIN products p ON p.id = qi.product_id
				WHERE ${scoped} AND qi.product_id IS NOT NULL GROUP BY qi.product_id ORDER BY name`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT cl.country AS value FROM quotes q JOIN clients cl ON cl.id = q.client_id WHERE ${scoped} AND NULLIF(TRIM(cl.country), '') IS NOT NULL ORDER BY value`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT q.quote_type AS value FROM quotes q WHERE ${scoped} AND NULLIF(TRIM(q.quote_type), '') IS NOT NULL`,
				[holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT cc.id, cc.name, cc.client_id FROM quotes q JOIN client_contacts cc ON cc.id = q.client_contact_id WHERE ${scoped} ORDER BY cc.name`,
				[holdingId]
			),
		]);
		const usedCodes = new Set(types.map((row) => normalizeQuoteType(toText(row.value))).filter(Boolean));

		return {
			stages: stages.map((row) => ({
				id: String(row.id),
				name: toText(row.name),
				color: toText(row.color),
				kind: toText(row.kind) ?? 'draft',
				position: toNumber(row.position),
			})),
			statuses: QUOTE_DERIVED_STATUSES.map((value) => ({ value, label: QUOTE_STATUS_LABELS[value] })),
			quote_types: QUOTE_TYPE_CODES.map((code) => ({ value: code, label: quoteTypeLabel(code), used: usedCodes.has(code) })),
			sellers: sellers.map((row) => ({ id: String(row.id), name: toText(row.name) })),
			currencies: currencies.map((row) => String(row.value)),
			products: products.map((row) => ({ id: String(row.id), name: toText(row.name) })),
			client_countries: countries.map((row) => String(row.value)),
			contacts: contacts.map((row) => ({ id: String(row.id), name: toText(row.name), client_id: toText(row.client_id) })),
			origins: [
				{ value: 'salesforce', label: 'Salesforce' },
				{ value: 'manual', label: 'Manual' },
			],
		};
	}
}

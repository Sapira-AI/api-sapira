import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { resolveCountryInput } from '@/core/utils/country-resolve';
import { validationException } from '@/core/utils/validation-errors';
import { insertClientEntity } from '@/modules/clients/client-entity-writer';
import { withApiWriter } from '@/modules/contracts/api-writer';
import { monthsBetween } from '@/modules/metrics/metrics-period';

import {
	conflict,
	eventDto,
	insertOnboardingEvent,
	isoDate,
	normalizeName,
	normalizeNameSql,
	normalizeTaxId,
	normalizeTaxIdSql,
	num,
	numOrNull,
	omitKey,
	type OnboardingActor,
	paginated,
	type Queryable,
	queryEvents,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';
import {
	type FxWarning,
	fxWarningsOf,
	loadFxReferences,
	OnboardingRegisterService,
	REGISTER_MAX_MONTHS,
	SUM_TOLERANCE,
} from './onboarding-register.service';

import type {
	AssignInvoiceClientDto,
	CreateEntityInputDto,
	ImportApplyDto,
	ImportPreviewDto,
	PreviousInvoiceInputDto,
	PreviousInvoicesQueryDto,
	RegisterHistoryInvoiceDto,
} from './dtos/onboarding.dto';

export type ImportRowStatus = 'new' | 'duplicate' | 'error' | 'needs_entity' | 'needs_client';
/** Histórico en el mismo paso de la importación (Domi 14-10). */
export type ImportHistoryStatus = 'none' | 'ready' | 'incomplete' | 'error';

/** Histórico de una línea de la planilla (Domi 28-10: cada línea registra el suyo). */
export interface ImportRowHistoryLine {
	/** Posición de la línea en la factura (1 = primera). */
	index: number;
	product: { id: string; name: string | null } | null;
	contract_currency: string | null;
	fx_contract_to_invoice: number | null;
	warnings: FxWarning[];
}

export interface ImportRowHistory {
	status: ImportHistoryStatus;
	errors: string[];
	/** Producto de la primera línea con histórico (compatibilidad; el detalle va en `lines[]`). */
	product: { id: string; name: string | null } | null;
	/** Tipo de cambio de la primera línea con histórico (compatibilidad). */
	fx_contract_to_invoice: number | null;
	warnings: FxWarning[];
	/** Líneas que registran histórico, con su producto y tipo de cambio. */
	lines: ImportRowHistoryLine[];
}

/** Campos del histórico por línea de la planilla (todos o ninguno en cada línea). */
const HISTORY_ITEM_FIELDS = [
	['product', 'el producto'],
	['period_from', 'el período desde'],
	['period_to', 'el período hasta'],
	['contract_currency', 'la moneda de contrato'],
	['amount_contract_currency', 'el monto en moneda de contrato'],
] as const;

export interface ClientCandidate {
	id: string;
	name: string | null;
	score: number;
}

export interface ImportRowPlan {
	row: number;
	status: ImportRowStatus;
	errors: string[];
	entity: { id: string; legal_name: string | null } | null;
	client: { id: string; name: string | null } | null;
	entity_suggestion: { legal_name: string; tax_id: string | null; country: string | null; client_candidates: ClientCandidate[] } | null;
	company: { id: string } | null;
	history: ImportRowHistory;
	/** Productos resueltos por línea (solo para registrar el histórico; no sale en la respuesta). */
	history_products: Array<string | null>;
	input: PreviousInvoiceInputDto;
}

/** Similitud mínima (pg_trgm) para proponer un cliente comercial por nombre. */
export const CLIENT_CANDIDATE_MIN_SCORE = 0.3;
const SORT_COLUMNS: Record<string, string> = {
	issue_date: 'il.issue_date',
	due_date: 'il.due_date',
	invoice_number: 'il.invoice_number',
	client: 'cl.name_commercial',
	total: 'il.total_invoice_currency',
	status: 'il.status',
};
const entityKey = (legalName: string, taxId: string | null | undefined) =>
	normalizeTaxId(taxId) ? `t:${normalizeTaxId(taxId)}` : `n:${normalizeName(legalName)}`;

/**
 * Facturas previas (§3.2, §4.3, §5): lista y detalle, importación por planilla (vista previa → aplicar en una transacción → lote
 * reversible), relación de la razón social de una factura con un cliente comercial existente, lotes. Las facturas previas son evidencia y
 * cobranza: sin DTE, sin ERP, sin impuestos recalculados, sin devengo. **La importación nunca crea clientes comerciales** (vienen del
 * CRM): la factura se relaciona con su cliente por el RUT de la razón social (su `client_id` o `client_entity_clients`) o por el id del
 * CRM / número de cliente que traiga la fila; si no hay coincidencia queda `needs_client`. Las razones sociales solo se crean si vienen
 * confirmadas en `create_entities`. Ninguna escritura dispara notificaciones, correos ni sincronizaciones.
 */
@Injectable()
export class OnboardingPreviousInvoicesService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly register: OnboardingRegisterService
	) {}

	// ---------------------------------------------------------------- lista y detalle

	async list(holdingId: string, query: PreviousInvoicesQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 25;
		const params: unknown[] = [holdingId];
		const add = (value: unknown) => `$${params.push(value)}`;
		const where = ['il.holding_id = $1'];
		const statuses = (query.status ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);

		if (statuses.length) where.push(`il.status = ANY(${add(statuses)}::text[])`);
		if (query.linked === 'true') where.push('il.contract_id IS NOT NULL');
		if (query.linked === 'false') where.push('il.contract_id IS NULL');
		if (query.clientId) where.push(`COALESCE(il.client_id, ce.client_id) = ${add(query.clientId)}`);
		if (query.entityId) where.push(`il.client_entity_id = ${add(query.entityId)}`);
		if (query.batchId) where.push(`to_jsonb(il) ->> 'import_batch_id' = ${add(query.batchId)}`);
		if (query.hasHistory === 'true') where.push('EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)');
		if (query.hasHistory === 'false') where.push('NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)');
		if (query.adopted === 'true') where.push('il.reconciled_invoice_id IS NOT NULL');
		if (query.adopted === 'false') where.push('il.reconciled_invoice_id IS NULL');
		if (query.companyId) where.push(`il.company_id = ${add(query.companyId)}`);
		if (query.country) where.push(`upper(ce.country_code) = ${add(query.country)}`);
		if (query.search) {
			const term = add(`%${query.search}%`);

			where.push(`(il.invoice_number ILIKE ${term} OR il.legal_client_name ILIKE ${term} OR ce.legal_name ILIKE ${term})`);
		}
		if (query.from) where.push(`il.issue_date >= ${add(query.from)}::date`);
		if (query.to) where.push(`il.issue_date <= ${add(query.to)}::date`);
		const order = SORT_COLUMNS[query.sortBy ?? 'issue_date'] ?? SORT_COLUMNS.issue_date;
		const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
		const rows = (await this.dataSource.query(
			`SELECT ${this.invoiceColumns()}, COUNT(*) OVER () AS total_count
			FROM invoices_legacy il ${this.invoiceJoins()}
			WHERE ${where.join(' AND ')}
			ORDER BY ${order} ${direction} NULLS LAST, il.invoice_number
			LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`,
			params
		)) as Row[];

		return paginated(
			rows.map((row) => this.invoiceDto(row)),
			num(rows[0]?.total_count),
			page,
			limit
		);
	}

	async detail(holdingId: string, id: string) {
		const [row] = (await this.dataSource.query(
			`SELECT ${this.invoiceColumns()} FROM invoices_legacy il ${this.invoiceJoins()} WHERE il.holding_id = $1 AND il.id = $2`,
			[holdingId, id]
		)) as Row[];

		if (!row) throw new NotFoundException('Factura previa no encontrada');
		const invoice = this.invoiceDto(row);
		const [items, months, events] = await Promise.all([
			this.dataSource.query(
				`SELECT id, description, product_external_code, quantity, unit_price, discount_pct, currency, subtotal, tax_amount, total,
					EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_item_legacy_id = invoice_items_legacy.id) AS has_history
				FROM invoice_items_legacy WHERE invoices_legacy_id = $1 AND holding_id = $2 ORDER BY created_at, id`,
				[id, holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT m.id, to_char(m.period_month, 'YYYY-MM') AS period_month, m.product_name, m.contract_currency, m.subtotal_contract_currency,
					m.mrr_legacy, m.mrr_legacy_system_currency, m.term, m.is_recurring, m.migrated_to_contract_id, m.client_id
				FROM mrr_legacy m WHERE m.invoice_legacy_id = $1 AND m.holding_id = $2 ORDER BY m.period_month, m.product_name`,
				[id, holdingId]
			) as Promise<Row[]>,
			queryEvents(
				this.dataSource,
				`SELECT e.*, u.name AS actor_name FROM onboarding_events e LEFT JOIN users u ON u.id = e.actor_id
				WHERE e.holding_id = $1 AND (e.entity_id = $2 OR (e.entity_type = 'invoice_batch' AND e.entity_id = $3::uuid))
				ORDER BY e.created_at DESC LIMIT 50`,
				[holdingId, id, invoice.batch_id]
			),
		]);

		return {
			...invoice,
			items: items.map((item) => ({
				id: String(item.id),
				description: str(item.description),
				product_external_code: str(item.product_external_code),
				quantity: numOrNull(item.quantity),
				unit_price: numOrNull(item.unit_price),
				discount_pct: numOrNull(item.discount_pct),
				currency: str(item.currency),
				subtotal: num(item.subtotal),
				tax_amount: numOrNull(item.tax_amount),
				total: num(item.total),
				/** La línea ya tiene filas de MRR histórico (Domi 28-10: el registro es por línea). */
				has_history: item.has_history === true,
			})),
			history_months: months.map((month) => ({
				id: String(month.id),
				period_month: String(month.period_month),
				product_name: str(month.product_name),
				contract_currency: str(month.contract_currency),
				subtotal_contract_currency: num(month.subtotal_contract_currency),
				mrr_legacy: numOrNull(month.mrr_legacy),
				mrr_legacy_system_currency: numOrNull(month.mrr_legacy_system_currency),
				term: num(month.term),
				is_recurring: month.is_recurring === true,
				contract_id: str(month.migrated_to_contract_id),
			})),
			events: events.map(eventDto),
		};
	}

	private invoiceColumns() {
		return `il.id, il.invoice_number, il.issue_date, il.due_date, il.client_entity_id, ce.legal_name AS entity_legal_name, ce.tax_id AS entity_tax_id,
			il.legal_client_name, il.client_tax_id, COALESCE(il.client_id, ce.client_id) AS client_id, cl.name_commercial AS client_name,
			il.company_id, co.legal_name AS company_legal_name, il.invoice_currency, il.amount_invoice_currency, il.vat, il.total_invoice_currency,
			il.status, il.source_type, il.source_system, il.contract_id, ct.contract_number, to_jsonb(il) ->> 'import_batch_id' AS batch_id,
			il.notes, upper(ce.country_code) AS entity_country,
			EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id) AS has_history,
			(SELECT COUNT(*) FROM invoice_items_legacy ii WHERE ii.invoices_legacy_id = il.id
				AND NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_item_legacy_id = ii.id)) AS items_without_history,
			(SELECT COALESCE(SUM(x.allocated), 0) FROM (SELECT MAX(m.allocated_invoice_currency) AS allocated FROM mrr_legacy m
				WHERE m.invoice_legacy_id = il.id GROUP BY m.invoice_item_legacy_id, m.split_index) x) AS history_allocated,
			il.reconciliation_status, ri.id AS adopted_invoice_id, ri.invoice_number AS adopted_invoice_number, ri.status AS adopted_invoice_status,
			ri.contract_id AS adopted_contract_id, rc.contract_number AS adopted_contract_number`;
	}

	private invoiceJoins() {
		return `LEFT JOIN client_entities ce ON ce.id = il.client_entity_id
			LEFT JOIN clients cl ON cl.id = COALESCE(il.client_id, ce.client_id)
			LEFT JOIN companies co ON co.id = il.company_id
			LEFT JOIN contracts ct ON ct.id = il.contract_id
			LEFT JOIN invoices ri ON ri.id = il.reconciled_invoice_id
			LEFT JOIN contracts rc ON rc.id = ri.contract_id`;
	}

	private invoiceDto(row: Row) {
		return {
			id: String(row.id),
			invoice_number: str(row.invoice_number),
			issue_date: isoDate(row.issue_date),
			due_date: isoDate(row.due_date),
			entity: row.client_entity_id
				? { id: String(row.client_entity_id), legal_name: str(row.entity_legal_name), tax_id: str(row.entity_tax_id) }
				: null,
			legal_client_name: str(row.legal_client_name),
			client_tax_id: str(row.client_tax_id),
			client: row.client_id ? { id: String(row.client_id), name: str(row.client_name) } : null,
			company: { id: String(row.company_id), legal_name: str(row.company_legal_name) },
			currency: str(row.invoice_currency),
			amount: num(row.amount_invoice_currency),
			vat: numOrNull(row.vat),
			total: num(row.total_invoice_currency),
			status: str(row.status),
			source_type: str(row.source_type),
			source_system: str(row.source_system),
			notes: str(row.notes),
			/** País de la razón social (ISO 3166-1 alfa-2). */
			country: str(row.entity_country),
			/** Siempre externa: no se emitió desde Sapira (§3.2). */
			origin: 'external' as const,
			contract: row.contract_id ? { id: String(row.contract_id), contract_number: str(row.contract_number) } : null,
			batch_id: str(row.batch_id),
			has_history: row.has_history === true,
			/**
			 * Registrada a medias (Domi 28-10): tiene filas, alguna línea de factura no tiene las suyas y lo registrado no cubre el neto (una
			 * factura registrada entera antes de la regla por línea no es parcial). Las líneas que faltan se registran con Registrar histórico.
			 */
			history_partial:
				row.has_history === true &&
				num(row.items_without_history) > 0 &&
				Math.abs(num(row.history_allocated)) < Math.abs(num(row.amount_invoice_currency)) * (1 - SUM_TOLERANCE) - 0.005,
			/** Adoptada como factura del contrato (§4.5): la factura de Sapira que nació de esta (`reconciled_invoice_id`). */
			adopted: row.adopted_invoice_id
				? {
						invoice_id: String(row.adopted_invoice_id),
						invoice_number: str(row.adopted_invoice_number),
						status: str(row.adopted_invoice_status),
						contract_id: str(row.adopted_contract_id),
						contract_number: str(row.adopted_contract_number),
					}
				: null,
		};
	}

	/** Compañías emisoras y países de razón social presentes en las facturas previas del holding (para los filtros de la lista). */
	async filterOptions(holdingId: string) {
		const [companies, countries] = await Promise.all([
			this.dataSource.query(
				`SELECT DISTINCT co.id, co.legal_name FROM invoices_legacy il JOIN companies co ON co.id = il.company_id
				WHERE il.holding_id = $1 ORDER BY co.legal_name, co.id`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT DISTINCT upper(ce.country_code) AS country FROM invoices_legacy il JOIN client_entities ce ON ce.id = il.client_entity_id
				WHERE il.holding_id = $1 AND NULLIF(btrim(ce.country_code), '') IS NOT NULL ORDER BY 1`,
				[holdingId]
			) as Promise<Row[]>,
		]);

		return {
			companies: companies.map((row) => ({ id: String(row.id), legal_name: str(row.legal_name) })),
			countries: countries.map((row) => String(row.country)),
		};
	}

	// ---------------------------------------------------------------- importación

	async previewImport(holdingId: string, dto: ImportPreviewDto) {
		const rows = await this.planImport(this.dataSource, holdingId, dto.invoices);
		const missing = new Map<string, { legal_name: string; tax_id: string | null; rows: number[]; client_candidates: ClientCandidate[] }>();

		for (const row of rows.filter((plan) => plan.status === 'needs_entity')) {
			const key = entityKey(row.input.legal_client_name, row.input.client_tax_id);
			const entry = missing.get(key) ?? {
				legal_name: row.input.legal_client_name,
				tax_id: row.input.client_tax_id ?? null,
				rows: [],
				client_candidates: row.entity_suggestion?.client_candidates ?? [],
			};

			entry.rows.push(row.row);
			missing.set(key, entry);
		}
		const byCurrency = new Map<string, { currency: string; count: number; total: number }>();

		for (const row of rows.filter((plan) => plan.status !== 'error' && plan.status !== 'duplicate')) {
			const entry = byCurrency.get(row.input.currency) ?? { currency: row.input.currency, count: 0, total: 0 };

			entry.count += 1;
			entry.total = round2(entry.total + row.input.total);
			byCurrency.set(row.input.currency, entry);
		}
		const count = (status: ImportRowStatus) => rows.filter((row) => row.status === status).length;

		const historyCount = (status: ImportHistoryStatus) => rows.filter((row) => row.history.status === status).length;

		return {
			rows: rows.map((row) => omitKey(omitKey(row, 'input'), 'history_products')),
			summary: {
				new: count('new'),
				duplicate: count('duplicate'),
				error: count('error'),
				needs_entity: count('needs_entity'),
				needs_client: count('needs_client'),
				by_currency: [...byCurrency.values()],
				history_ready: historyCount('ready'),
				history_incomplete: historyCount('incomplete'),
				history_error: historyCount('error'),
			},
			missing_entities: [...missing.values()],
			missing_companies: [...new Set(rows.flatMap((row) => (row.company ? [] : [row.input.company_name])))],
		};
	}

	/** Clasifica cada fila: `error` > `duplicate` > `needs_entity` > `needs_client` > `new`. */
	async planImport(db: Queryable, holdingId: string, invoices: PreviousInvoiceInputDto[]): Promise<ImportRowPlan[]> {
		const numbers = [...new Set(invoices.map((row) => row.invoice_number))];
		const erpIds = [...new Set(invoices.map((row) => row.erp_invoice_id).filter((id): id is number => typeof id === 'number'))];
		const taxIds = [...new Set(invoices.map((row) => normalizeTaxId(row.client_tax_id)).filter(Boolean))];
		const names = [...new Set(invoices.map((row) => normalizeName(row.legal_client_name)))];
		const crmIds = [...new Set(invoices.map((row) => row.client_crm_id).filter(Boolean))] as string[];
		const clientNumbers = [...new Set(invoices.map((row) => row.client_number).filter(Boolean))] as string[];
		const [companies, existing, entities, clientsByRef] = await Promise.all([
			db.query(`SELECT id, legal_name, currency, tax_id, country_code FROM companies WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
			db.query(
				`SELECT invoice_number, odoo_integration_id FROM invoices_legacy
				WHERE holding_id = $1 AND (invoice_number = ANY($2::text[]) OR odoo_integration_id = ANY($3::int[]))`,
				[holdingId, numbers, erpIds]
			) as Promise<Row[]>,
			db.query(
				`SELECT ce.id, ce.legal_name, ce.tax_id, ce.client_id, cl.name_commercial AS client_name,
					COALESCE((SELECT json_agg(json_build_object('id', x.client_id, 'name', c2.name_commercial, 'primary', x.is_primary))
						FROM client_entity_clients x JOIN clients c2 ON c2.id = x.client_id WHERE x.client_entity_id = ce.id), '[]') AS links
				FROM client_entities ce LEFT JOIN clients cl ON cl.id = ce.client_id
				WHERE ce.holding_id = $1 AND (${normalizeTaxIdSql('ce.tax_id')} = ANY($2::text[]) OR ${normalizeNameSql('ce.legal_name')} = ANY($3::text[]))
				ORDER BY ce.legal_name, ce.id`,
				[holdingId, taxIds, names]
			) as Promise<Row[]>,
			crmIds.length || clientNumbers.length
				? (db.query(
						`SELECT id, name_commercial, salesforce_account_id, client_number FROM clients
						WHERE holding_id = $1 AND (salesforce_account_id = ANY($2::text[]) OR client_number = ANY($3::text[]))`,
						[holdingId, crmIds, clientNumbers]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const existingNumbers = new Set(existing.map((row) => String(row.invoice_number)));
		const existingErp = new Set(existing.map((row) => numOrNull(row.odoo_integration_id)).filter((id) => id !== null));
		const seenNumbers = new Set<string>();
		const seenErp = new Set<number>();
		const plans: ImportRowPlan[] = invoices.map((input) => {
			const errors: string[] = [];
			const resolved = this.companyOf(companies, input);
			const company = resolved.company;

			if (!resolved.matches.length) errors.push(`La compañía emisora "${input.company_name}" no existe en el holding`);
			else if (!company) {
				const where = resolved.matches.map((match) => str(match.country_code) ?? str(match.currency) ?? '?').join(', ');

				errors.push(
					`Hay varias compañías llamadas "${input.company_name}" (${where}): indica company_tax_id o company_country para saber cuál emitió la factura`
				);
			}
			if (!input.items.length) errors.push('La factura no tiene líneas');
			const duplicate =
				existingNumbers.has(input.invoice_number) ||
				seenNumbers.has(input.invoice_number) ||
				(input.erp_invoice_id !== undefined && (existingErp.has(input.erp_invoice_id) || seenErp.has(input.erp_invoice_id)));

			seenNumbers.add(input.invoice_number);
			if (input.erp_invoice_id !== undefined) seenErp.add(input.erp_invoice_id);
			const tax = normalizeTaxId(input.client_tax_id);
			const entity =
				(tax ? entities.find((row) => normalizeTaxId(row.tax_id) === tax) : undefined) ??
				entities.find((row) => normalizeName(row.legal_name) === normalizeName(input.legal_client_name)) ??
				null;
			const client = this.clientOf(entity, input, clientsByRef);
			const status: ImportRowStatus = errors.length
				? 'error'
				: duplicate
					? 'duplicate'
					: !entity
						? 'needs_entity'
						: !client
							? 'needs_client'
							: 'new';

			return {
				row: input.row,
				status,
				errors,
				entity: entity ? { id: String(entity.id), legal_name: str(entity.legal_name) } : null,
				client,
				entity_suggestion: entity
					? null
					: { legal_name: input.legal_client_name, tax_id: input.client_tax_id ?? null, country: null, client_candidates: [] },
				company: company ? { id: String(company.id) } : null,
				history: { status: 'none', errors: [], product: null, fx_contract_to_invoice: null, warnings: [], lines: [] },
				history_products: [],
				input,
			};
		});
		const lookup = plans.filter((plan) => (plan.status === 'needs_entity' || plan.status === 'needs_client') && !plan.client);
		const candidates = await this.clientCandidates(db, holdingId, [...new Set(lookup.map((plan) => plan.input.legal_client_name))]);
		const countries = new Map(companies.map((row) => [String(row.id), str(row.country_code)]));

		for (const plan of plans) {
			if (plan.entity_suggestion) {
				// País: el de la fila (de la razón social) o, sin él, el de la compañía emisora.
				plan.entity_suggestion.country = plan.input.country ?? (plan.company ? (countries.get(plan.company.id) ?? null) : null);
				// Cliente comercial por id del CRM o número de cliente: primer candidato (seguro) para crear la razón social.
				plan.entity_suggestion.client_candidates = plan.client
					? [{ id: plan.client.id, name: plan.client.name, score: 1 }]
					: (candidates.get(plan.input.legal_client_name) ?? []);
			}
		}
		await this.planHistory(db, holdingId, plans);

		return plans;
	}

	/**
	 * Histórico en el mismo paso (Domi 14-10), **por línea y opcional** (Domi 28-10): una línea que trae producto del catálogo (nombre o
	 * código), período, moneda y monto en moneda de contrato registra su propio MRR histórico; una línea sin ninguno de esos campos entra
	 * solo como línea de la factura. Por factura: `ready` si al menos una línea está completa y ninguna a medias; `incomplete` si alguna
	 * línea trae solo parte de los campos; `error` si un producto no existe, un período o moneda es inválido, la suma de las líneas no cuadra
	 * con el neto (±1 %) o no hay cliente comercial; `none` si ninguna línea trae datos de histórico. Tipo de cambio y avisos por línea
	 * (subtotal de la línea ÷ monto en moneda de contrato), con la misma regla que Registrar histórico.
	 */
	private async planHistory(db: Queryable, holdingId: string, plans: ImportRowPlan[]) {
		const hasHistory = (item: PreviousInvoiceInputDto['items'][number]) => HISTORY_ITEM_FIELDS.some(([field]) => item[field] !== undefined);
		const wanted = plans.filter((plan) => plan.input.items.some(hasHistory));

		if (!wanted.length) return;
		const [products, currencies, references] = await Promise.all([
			db.query(`SELECT id, name, product_code FROM products WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
			db.query(`SELECT code FROM currencies WHERE is_active = true`) as Promise<Row[]>,
			loadFxReferences(db, holdingId),
		]);
		const known = new Set(currencies.map((row) => String(row.code)));
		const resolve = (value: string) => {
			const byCode = products.filter((product) => str(product.product_code) === value);
			const matches = byCode.length ? byCode : products.filter((product) => normalizeName(product.name) === normalizeName(value));

			return matches.length === 1 ? matches[0] : matches.length ? 'ambiguous' : null;
		};

		for (const plan of wanted) {
			const { input } = plan;
			const errors: string[] = [];
			const missing: string[] = [];
			const resolved: Array<string | null> = [];
			const lines: ImportRowHistoryLine[] = [];

			input.items.forEach((item, index) => {
				const label = `Línea ${index + 1}`;

				if (!hasHistory(item)) {
					resolved.push(null);

					return;
				}
				for (const [field, name] of HISTORY_ITEM_FIELDS) if (item[field] === undefined) missing.push(`${label}: falta ${name}`);
				let product: ImportRowHistoryLine['product'] = null;

				if (item.product !== undefined) {
					const match = resolve(item.product);

					if (match === 'ambiguous') errors.push(`${label}: hay varios productos "${item.product}" en el catálogo`);
					else if (!match) errors.push(`${label}: el producto "${item.product}" no está en el catálogo`);
					else product = { id: String(match.id), name: str(match.name) };
				}
				resolved.push(product?.id ?? null);
				if (item.period_from && item.period_to) {
					const span = monthsBetween(item.period_from, item.period_to);

					if (span < 0 || span >= REGISTER_MAX_MONTHS)
						errors.push(`${label}: período inválido (hasta antes de desde o más de ${REGISTER_MAX_MONTHS} meses)`);
				}
				if (item.contract_currency && known.size && !known.has(item.contract_currency)) {
					errors.push(`${label}: la moneda ${item.contract_currency} no está habilitada`);
				}
				const complete = HISTORY_ITEM_FIELDS.every(([field]) => item[field] !== undefined);
				const fx = complete && item.amount_contract_currency ? round6(item.subtotal / item.amount_contract_currency!) : null;

				if (complete && item.amount_contract_currency !== undefined && (fx === null ? item.subtotal !== 0 : fx <= 0))
					errors.push(`${label}: el monto en moneda de contrato no es válido`);
				lines.push({
					index: index + 1,
					product,
					contract_currency: item.contract_currency ?? null,
					fx_contract_to_invoice: fx,
					warnings: fx !== null && item.contract_currency ? fxWarningsOf(input.currency, item.contract_currency, fx, references) : [],
				});
			});
			const complete = !missing.length;

			if (complete) {
				const itemsTotal = input.items.reduce((sum, item) => sum + item.subtotal, 0);

				if (Math.abs(itemsTotal - input.amount) > Math.abs(input.amount) * SUM_TOLERANCE + 0.005) {
					errors.push('La suma de las líneas no cuadra con el neto de la factura (±1 %)');
				}
				if (!plan.client) errors.push('La factura no tiene cliente comercial: registra el histórico después de relacionarla');
			}
			plan.history_products = resolved;
			plan.history = {
				status: errors.length ? 'error' : complete ? 'ready' : 'incomplete',
				errors: errors.length ? errors : complete ? [] : missing,
				product: lines[0]?.product ?? null,
				fx_contract_to_invoice: lines[0]?.fx_contract_to_invoice ?? null,
				warnings: [...new Set(lines.flatMap((line) => line.warnings))],
				lines,
			};
		}
	}

	/**
	 * Lo de Registrar histórico (§3.2b) para una factura importada con histórico `ready`: una línea de registro por línea de la planilla
	 * que trae histórico, con su producto, período, moneda y monto; `itemIds` = ids de las líneas recién insertadas, en el orden de la planilla.
	 */
	private registerInputOf(plan: ImportRowPlan, invoiceId: string, itemIds: string[]): RegisterHistoryInvoiceDto {
		return {
			invoice_id: invoiceId,
			lines: plan.input.items.flatMap((item, index) => {
				const productId = plan.history_products[index];

				if (!productId) return [];

				return [
					{
						item_id: itemIds[index],
						period_from: item.period_from!,
						period_to: item.period_to!,
						contract_currency: item.contract_currency!,
						amount_contract_currency: item.amount_contract_currency!,
						is_recurring: item.is_recurring ?? true,
						products: [{ product_id: productId, amount_contract_currency: item.amount_contract_currency! }],
					},
				];
			}),
		};
	}

	/**
	 * Compañía emisora de la fila (Domi 28-10, para holdings con compañías del mismo nombre en varios países): por identificador fiscal
	 * (`company_tax_id`), si no por nombre + país (`company_country`), si no por nombre + moneda de la factura, si no por nombre único.
	 * `matches` = las compañías con ese nombre (o RUT), para explicar la ambigüedad.
	 */
	private companyOf(companies: Row[], input: PreviousInvoiceInputDto): { company: Row | null; matches: Row[] } {
		const tax = normalizeTaxId(input.company_tax_id);
		const byTax = tax ? companies.filter((company) => normalizeTaxId(str(company.tax_id)) === tax) : [];

		if (byTax.length === 1) return { company: byTax[0], matches: byTax };
		const matches = companies.filter((company) => normalizeName(company.legal_name) === normalizeName(input.company_name));
		const country = input.company_country?.toUpperCase();
		const byCountry = country ? matches.filter((company) => String(company.country_code ?? '').toUpperCase() === country) : [];
		const byCurrency = matches.filter((company) => String(company.currency ?? '').toUpperCase() === input.currency);
		const company = byCountry.length === 1 ? byCountry[0] : matches.length === 1 ? matches[0] : byCurrency.length === 1 ? byCurrency[0] : null;

		return { company, matches: byTax.length ? byTax : matches };
	}

	/** Cliente comercial de la fila: el de la razón social (principal o único vínculo) y, si no tiene, el del id del CRM o número de cliente. */
	private clientOf(entity: Row | null, input: PreviousInvoiceInputDto, clientsByRef: Row[]) {
		if (entity?.client_id) return { id: String(entity.client_id), name: str(entity.client_name) };
		const links = (typeof entity?.links === 'string' ? JSON.parse(entity.links) : (entity?.links ?? [])) as Array<{
			id: string;
			name: string | null;
			primary: boolean;
		}>;
		const link = links.find((item) => item.primary) ?? (links.length === 1 ? links[0] : undefined);

		if (link) return { id: String(link.id), name: link.name ?? null };
		const byRef =
			(input.client_crm_id ? clientsByRef.find((row) => row.salesforce_account_id === input.client_crm_id) : undefined) ??
			(input.client_number ? clientsByRef.find((row) => row.client_number === input.client_number) : undefined);

		return byRef ? { id: String(byRef.id), name: str(byRef.name_commercial) } : null;
	}

	/** Hasta 5 clientes comerciales por nombre parecido (pg_trgm `similarity`), para elegir a mano. */
	private async clientCandidates(db: Queryable, holdingId: string, names: string[]): Promise<Map<string, ClientCandidate[]>> {
		const out = new Map<string, ClientCandidate[]>();

		if (!names.length) return out;
		const rows = (await db.query(
			`SELECT n.name AS wanted, c.id, c.name_commercial, c.score
			FROM unnest($2::text[]) AS n(name)
			CROSS JOIN LATERAL (
				SELECT cl.id, cl.name_commercial, public.similarity(lower(cl.name_commercial), lower(n.name)) AS score
				FROM clients cl WHERE cl.holding_id = $1
				ORDER BY score DESC LIMIT 5
			) c
			WHERE c.score >= $3`,
			[holdingId, names, CLIENT_CANDIDATE_MIN_SCORE]
		)) as Row[];

		for (const row of rows) {
			const list = out.get(String(row.wanted)) ?? [];

			list.push({ id: String(row.id), name: str(row.name_commercial), score: round6(num(row.score)) });
			out.set(String(row.wanted), list);
		}

		return out;
	}

	async applyImport(holdingId: string, dto: ImportApplyDto, actor: OnboardingActor) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const entitiesCreated = await this.createEntities(runner, holdingId, dto.create_entities ?? []);
			const plans = await this.planImport(runner, holdingId, dto.invoices);
			const batchId = randomUUID();
			let inserted = 0;
			let needsClient = 0;
			const historyInputs: Array<{ row: number; invoice_number: string; input: RegisterHistoryInvoiceDto }> = [];

			for (const plan of plans.filter((row) => row.status === 'new' || row.status === 'needs_client')) {
				const { invoiceId, itemIds } = await this.insertInvoice(runner, holdingId, plan, batchId, actor);

				inserted += 1;
				if (plan.status === 'needs_client') needsClient += 1;
				if (plan.history.status === 'ready') {
					historyInputs.push({
						row: plan.row,
						invoice_number: plan.input.invoice_number,
						input: this.registerInputOf(plan, invoiceId, itemIds),
					});
				}
			}
			const skippedDuplicates = plans.filter((row) => row.status === 'duplicate').length;
			const errors = plans.filter((row) => row.status === 'error' || row.status === 'needs_entity').length;

			if (!inserted) {
				throw conflict('nothing_to_import', 'No hay facturas nuevas para importar', {
					blockers: [{ code: 'nothing_to_import', duplicates: skippedDuplicates, errors }],
				});
			}
			// Histórico de las facturas `ready` en la misma transacción, con el motor de Registrar histórico (mismas reglas y avisos). Los
			// registros de MRR legacy nacen con un `batch_id` por cliente × moneda (Domi 18-10; nunca uno por importación): el lote guarda sus
			// `history_batch_ids` en el evento para que revertirlo revierta también ese histórico.
			const history = historyInputs.length
				? await this.register.registerInTx(
						runner,
						holdingId,
						historyInputs.map((entry) => entry.input),
						actor
					)
				: {
						created_rows: 0,
						records_touched: [] as string[],
						batch_ids: [] as string[],
						skipped: [] as Array<{ invoice_id: string; item_id: string | null; reason: string }>,
					};
			const rowOf = new Map(historyInputs.map((entry) => [entry.input.invoice_id, entry]));
			const result = {
				batch_id: batchId,
				inserted,
				skipped_duplicates: skippedDuplicates,
				errors,
				entities_created: entitiesCreated,
				needs_client: needsClient,
				history_rows_created: history.created_rows,
				history_records_touched: history.records_touched,
				history_batch_ids: history.batch_ids,
				history_skipped: history.skipped.map((skip) => ({
					row: rowOf.get(skip.invoice_id)?.row ?? null,
					invoice_number: rowOf.get(skip.invoice_id)?.invoice_number ?? null,
					line: (rowOf.get(skip.invoice_id)?.input.lines.findIndex((line) => line.item_id === skip.item_id) ?? -1) + 1 || null,
					reason: skip.reason,
				})),
			};

			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'previous_invoices_imported',
				entityType: 'invoice_batch',
				entityId: batchId,
				payload: { label: dto.batch_label ?? null, ...result },
			});

			return result;
		});
	}

	/**
	 * Razones sociales confirmadas en bloque. Nunca un cliente comercial: `client_id`, si viene, debe existir en el holding (400 si no).
	 * Con cliente se usa el camino único de Clientes (`insertClientEntity`); sin cliente nace suelta y la factura queda `needs_client`.
	 * Las que ya existen (mismo RUT o nombre) no se duplican.
	 */
	private async createEntities(db: Queryable, holdingId: string, inputs: CreateEntityInputDto[]): Promise<number> {
		if (!inputs.length) return 0;
		const clientIds = [...new Set(inputs.map((input) => input.client_id).filter(Boolean))] as string[];
		const found = clientIds.length
			? new Set(
					((await db.query(`SELECT id FROM clients WHERE holding_id = $1 AND id = ANY($2::uuid[])`, [holdingId, clientIds])) as Row[]).map(
						(row) => String(row.id)
					)
				)
			: new Set<string>();
		const unknown = inputs.map((input, index) => ({ input, index })).filter(({ input }) => input.client_id && !found.has(input.client_id));

		if (unknown.length) {
			throw validationException(
				unknown.map(({ index }) => ({ field: `create_entities.${index}.client_id`, message: 'El cliente comercial no existe en el holding' }))
			);
		}
		let created = 0;
		const done = new Set<string>();

		for (const input of inputs) {
			const key = entityKey(input.legal_name, input.tax_id);

			if (done.has(key)) continue;
			done.add(key);
			const tax = normalizeTaxId(input.tax_id);
			const [exists] = (await db.query(
				`SELECT id FROM client_entities WHERE holding_id = $1 AND (($2 <> '' AND ${normalizeTaxIdSql('tax_id')} = $2) OR ${normalizeNameSql('legal_name')} = $3) LIMIT 1`,
				[holdingId, tax, normalizeName(input.legal_name)]
			)) as Row[];

			if (exists) continue;
			const isCode = /^[A-Za-z]{2}$/.test(input.country);

			if (input.client_id) {
				await insertClientEntity(
					db as Parameters<typeof insertClientEntity>[0],
					holdingId,
					{
						client_id: input.client_id,
						legal_name: input.legal_name,
						// `client_entities.tax_id` admite NULL (Brasil viene sin RUT).
						tax_id: (input.tax_id ?? null) as string,
						country: isCode ? '' : input.country,
						country_code: isCode ? input.country.toUpperCase() : null,
						address: null,
						email: null,
						payment_terms: null,
					},
					{ makePrimaryIfNone: true }
				);
			} else {
				const country = (await resolveCountryInput(db, isCode ? { country_code: input.country } : { country: input.country })) ?? {
					country: input.country,
					country_code: null,
				};

				await db.query(`INSERT INTO client_entities (holding_id, legal_name, tax_id, country, country_code) VALUES ($1, $2, $3, $4, $5)`, [
					holdingId,
					input.legal_name,
					input.tax_id ?? null,
					country.country,
					country.country_code,
				]);
			}
			created += 1;
		}

		return created;
	}

	/** Inserta la factura y sus líneas; devuelve el id de la factura y los de las líneas en el orden de la planilla. */
	private async insertInvoice(
		db: Queryable,
		holdingId: string,
		plan: ImportRowPlan,
		batchId: string,
		actor: OnboardingActor
	): Promise<{ invoiceId: string; itemIds: string[] }> {
		const input = plan.input;
		const [row] = (await db.query(
			`INSERT INTO invoices_legacy (holding_id, company_id, client_id, client_entity_id, client_tax_id, legal_client_name, source_type,
				source_system, invoice_number, issue_date, due_date, invoice_currency, amount_invoice_currency, total_invoice_currency, vat, status,
				notes, created_by, odoo_integration_id, import_batch_id, reconciliation_status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'pending')
			RETURNING id`,
			[
				holdingId,
				plan.company!.id,
				plan.client?.id ?? null,
				plan.entity?.id ?? null,
				input.client_tax_id ?? null,
				input.legal_client_name,
				input.source_type ?? 'historical_import',
				input.source_system ?? null,
				input.invoice_number,
				input.issue_date,
				input.due_date ?? null,
				input.currency,
				input.amount,
				input.total,
				input.vat ?? null,
				input.status ?? 'Enviada',
				input.notes ?? null,
				actor.userId || null,
				input.erp_invoice_id ?? null,
				batchId,
			]
		)) as Row[];
		const values: unknown[] = [];
		const tuples = input.items.map((item) => {
			const quantity = item.quantity && item.quantity !== 0 ? item.quantity : 1;
			const base = values.length;

			values.push(
				row.id,
				holdingId,
				item.product_external_code ?? null,
				item.description ?? '',
				quantity,
				item.unit_price ?? round2(item.subtotal / quantity),
				item.discount_pct ?? 0,
				input.currency,
				item.subtotal,
				item.tax_amount ?? 0,
				item.total ?? round2(item.subtotal + (item.tax_amount ?? 0))
			);

			return `(${Array.from({ length: 11 }, (_, i) => `$${base + i + 1}`).join(', ')})`;
		});

		const items = (await db.query(
			`INSERT INTO invoice_items_legacy (invoices_legacy_id, holding_id, product_external_code, description, quantity, unit_price, discount_pct,
				currency, subtotal, tax_amount, total)
			VALUES ${tuples.join(', ')}
			RETURNING id`,
			values
		)) as Row[] | undefined;

		return { invoiceId: String(row.id), itemIds: Array.isArray(items) ? items.map((item) => String(item.id)) : [] };
	}

	/**
	 * Revierte un lote: borra sus facturas (y líneas). El MRR histórico registrado por la misma importación (los `history_batch_ids` del
	 * evento del lote —o el lote mismo en importaciones anteriores al 18-10—, sin empalmar) se borra también; cualquier otro histórico sobre
	 * esas facturas (otro registro, una unificación, filas empalmadas) bloquea con `batch_has_history`, igual que un contrato vinculado
	 * (`batch_linked`).
	 */
	async revertImport(holdingId: string, batchId: string, actor: OnboardingActor) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const [imported] = (await runner.query(
				`SELECT payload -> 'history_batch_ids' AS history_batch_ids FROM onboarding_events
				WHERE holding_id = $1 AND type = 'previous_invoices_imported' AND entity_id = $2 ORDER BY created_at LIMIT 1`,
				[holdingId, batchId]
			)) as Row[];

			if (!imported) throw new NotFoundException('Importación no encontrada');
			const stored = typeof imported.history_batch_ids === 'string' ? JSON.parse(imported.history_batch_ids) : imported.history_batch_ids;
			const historyBatches: string[] = Array.isArray(stored) && stored.length ? stored.map(String) : [batchId];
			const [batch] = (await runner.query(
				`SELECT
					EXISTS (SELECT 1 FROM onboarding_events WHERE holding_id = $1 AND type = 'previous_invoices_reverted' AND entity_id = $2) AS reverted,
					(SELECT COUNT(*) FROM invoices_legacy il WHERE il.holding_id = $1 AND il.import_batch_id = $2
						AND EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id
							AND (m.batch_id <> ALL($3::uuid[]) OR m.migrated_to_contract_id IS NOT NULL))) AS with_history,
					(SELECT COUNT(*) FROM invoices_legacy il WHERE il.holding_id = $1 AND il.import_batch_id = $2 AND il.contract_id IS NOT NULL) AS linked`,
				[holdingId, batchId, historyBatches]
			)) as Row[];

			if (batch?.reverted) throw conflict('already_reverted', 'La importación ya está revertida');
			if (num(batch.with_history) > 0) {
				throw conflict('batch_has_history', `${num(batch.with_history)} factura(s) del lote ya tienen MRR histórico registrado`, {
					blockers: [{ code: 'batch_has_history', count: num(batch.with_history) }],
				});
			}
			if (num(batch.linked) > 0) {
				throw conflict('batch_linked', `${num(batch.linked)} factura(s) del lote ya están vinculadas a un contrato`, {
					blockers: [{ code: 'batch_linked', count: num(batch.linked) }],
				});
			}
			const historyRemoved = (await runner.query(
				`DELETE FROM mrr_legacy m WHERE m.holding_id = $1 AND m.batch_id = ANY($3::uuid[]) AND m.migrated_to_contract_id IS NULL
					AND m.invoice_legacy_id IN (SELECT il.id FROM invoices_legacy il WHERE il.holding_id = $1 AND il.import_batch_id = $2)
				RETURNING m.id`,
				[holdingId, batchId, historyBatches]
			)) as Row[];
			const removed = (await runner.query(`DELETE FROM invoices_legacy WHERE holding_id = $1 AND import_batch_id = $2 RETURNING id`, [
				holdingId,
				batchId,
			])) as Row[];

			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'previous_invoices_reverted',
				entityType: 'invoice_batch',
				entityId: batchId,
				payload: { removed: removed.length, history_rows_removed: historyRemoved.length },
			});

			return { batch_id: batchId, removed: removed.length, history_rows_removed: historyRemoved.length };
		});
	}

	async batches(holdingId: string) {
		const rows = await queryEvents(
			this.dataSource,
			`SELECT e.entity_id AS id, e.payload ->> 'label' AS label, e.created_at, u.name AS created_by,
				(SELECT COUNT(*) FROM invoices_legacy il WHERE il.holding_id = e.holding_id AND il.import_batch_id = e.entity_id) AS count,
				EXISTS (SELECT 1 FROM onboarding_events r WHERE r.holding_id = e.holding_id AND r.type = 'previous_invoices_reverted' AND r.entity_id = e.entity_id) AS reverted
			FROM onboarding_events e LEFT JOIN users u ON u.id = e.actor_id
			WHERE e.holding_id = $1 AND e.type = 'previous_invoices_imported'
			ORDER BY e.created_at DESC`,
			[holdingId]
		);

		return rows.map((row) => ({
			id: String(row.id),
			label: str(row.label),
			created_at: row.created_at instanceof Date ? row.created_at.toISOString() : str(row.created_at),
			created_by: str(row.created_by),
			count: num(row.count),
			reverted: row.reverted === true,
		}));
	}

	/**
	 * Relaciona la razón social de la factura con un cliente comercial existente (`client_entity_clients`; si la razón social no tenía
	 * cliente, este pasa a ser el principal) y completa el cliente en sus facturas previas que no lo tenían.
	 */
	async assignClient(holdingId: string, id: string, dto: AssignInvoiceClientDto, actor: OnboardingActor) {
		await withApiWriter(this.dataSource, async (runner) => {
			const [invoice] = (await runner.query(
				`SELECT il.id, il.client_entity_id, ce.client_id AS entity_client_id FROM invoices_legacy il
				LEFT JOIN client_entities ce ON ce.id = il.client_entity_id
				WHERE il.holding_id = $1 AND il.id = $2 FOR UPDATE OF il`,
				[holdingId, id]
			)) as Row[];

			if (!invoice) throw new NotFoundException('Factura previa no encontrada');
			if (!invoice.client_entity_id)
				throw conflict('invoice_without_entity', 'La factura no tiene razón social: impórtala con su razón social primero');
			const [client] = (await runner.query(`SELECT id FROM clients WHERE id = $1 AND holding_id = $2`, [dto.client_id, holdingId])) as Row[];

			if (!client) throw new NotFoundException('Cliente comercial no encontrado');
			// El trigger `sync_client_entity_primary_client` copia el principal a `client_entities.client_id`.
			await runner.query(
				`INSERT INTO client_entity_clients (client_entity_id, client_id, holding_id, is_primary) VALUES ($1, $2, $3, $4)
				ON CONFLICT (client_entity_id, client_id) DO NOTHING`,
				[invoice.client_entity_id, dto.client_id, holdingId, !invoice.entity_client_id]
			);
			const updated = (await runner.query(
				`UPDATE invoices_legacy SET client_id = $3 WHERE holding_id = $1 AND client_entity_id = $2 AND client_id IS NULL RETURNING id`,
				[holdingId, invoice.client_entity_id, dto.client_id]
			)) as Row[];

			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'previous_invoice_client_linked',
				entityType: 'invoice_legacy',
				entityId: id,
				payload: { client_entity_id: invoice.client_entity_id, client_id: dto.client_id, invoices_updated: updated.length },
			});
		});

		return this.detail(holdingId, id);
	}
}

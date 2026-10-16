import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { resolveCountryInput } from '@/core/utils/country-resolve';
import { validationException } from '@/core/utils/validation-errors';
import { insertClientEntity } from '@/modules/clients/client-entity-writer';
import { withApiWriter } from '@/modules/contracts/api-writer';

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

import type {
	AssignInvoiceClientDto,
	CreateEntityInputDto,
	ImportApplyDto,
	ImportPreviewDto,
	PreviousInvoiceInputDto,
	PreviousInvoicesQueryDto,
} from './dtos/onboarding.dto';

export type ImportRowStatus = 'new' | 'duplicate' | 'error' | 'needs_entity' | 'needs_client';

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
	constructor(private readonly dataSource: DataSource) {}

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
				`SELECT id, description, product_external_code, quantity, unit_price, discount_pct, currency, subtotal, tax_amount, total
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
			EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id) AS has_history`;
	}

	private invoiceJoins() {
		return `LEFT JOIN client_entities ce ON ce.id = il.client_entity_id
			LEFT JOIN clients cl ON cl.id = COALESCE(il.client_id, ce.client_id)
			LEFT JOIN companies co ON co.id = il.company_id
			LEFT JOIN contracts ct ON ct.id = il.contract_id`;
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
			/** Siempre externa: no se emitió desde Sapira (§3.2). */
			origin: 'external' as const,
			contract: row.contract_id ? { id: String(row.contract_id), contract_number: str(row.contract_number) } : null,
			batch_id: str(row.batch_id),
			has_history: row.has_history === true,
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

		return {
			rows: rows.map((row) => omitKey(row, 'input')),
			summary: {
				new: count('new'),
				duplicate: count('duplicate'),
				error: count('error'),
				needs_entity: count('needs_entity'),
				needs_client: count('needs_client'),
				by_currency: [...byCurrency.values()],
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
			db.query(`SELECT id, legal_name, currency FROM companies WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
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
			const companyMatches = companies.filter((company) => normalizeName(company.legal_name) === normalizeName(input.company_name));
			const byCurrency = companyMatches.filter((company) => String(company.currency ?? '').toUpperCase() === input.currency);
			const company = companyMatches.length === 1 ? companyMatches[0] : byCurrency.length === 1 ? byCurrency[0] : null;

			if (!companyMatches.length) errors.push(`La compañía emisora "${input.company_name}" no existe en el holding`);
			else if (!company) errors.push(`Hay varias compañías llamadas "${input.company_name}": no se puede saber cuál emitió la factura`);
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
				input,
			};
		});
		const lookup = plans.filter((plan) => (plan.status === 'needs_entity' || plan.status === 'needs_client') && !plan.client);
		const candidates = await this.clientCandidates(db, holdingId, [...new Set(lookup.map((plan) => plan.input.legal_client_name))]);
		const countries = new Map(
			((await db.query(`SELECT id, country_code FROM companies WHERE holding_id = $1`, [holdingId])) as Row[]).map((row) => [
				String(row.id),
				str(row.country_code),
			])
		);

		for (const plan of plans) {
			if (plan.entity_suggestion) {
				plan.entity_suggestion.country = plan.company ? (countries.get(plan.company.id) ?? null) : null;
				plan.entity_suggestion.client_candidates = plan.client ? [] : (candidates.get(plan.input.legal_client_name) ?? []);
			}
		}

		return plans;
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

			for (const plan of plans.filter((row) => row.status === 'new' || row.status === 'needs_client')) {
				await this.insertInvoice(runner, holdingId, plan, batchId, actor);
				inserted += 1;
				if (plan.status === 'needs_client') needsClient += 1;
			}
			const skippedDuplicates = plans.filter((row) => row.status === 'duplicate').length;
			const errors = plans.filter((row) => row.status === 'error' || row.status === 'needs_entity').length;

			if (!inserted) {
				throw conflict('nothing_to_import', 'No hay facturas nuevas para importar', {
					blockers: [{ code: 'nothing_to_import', duplicates: skippedDuplicates, errors }],
				});
			}
			const result = {
				batch_id: batchId,
				inserted,
				skipped_duplicates: skippedDuplicates,
				errors,
				entities_created: entitiesCreated,
				needs_client: needsClient,
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

	private async insertInvoice(db: Queryable, holdingId: string, plan: ImportRowPlan, batchId: string, actor: OnboardingActor) {
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

		await db.query(
			`INSERT INTO invoice_items_legacy (invoices_legacy_id, holding_id, product_external_code, description, quantity, unit_price, discount_pct,
				currency, subtotal, tax_amount, total)
			VALUES ${tuples.join(', ')}`,
			values
		);
	}

	/** Revierte un lote: borra sus facturas (y líneas). Bloqueado si alguna ya tiene MRR histórico o contrato vinculado. */
	async revertImport(holdingId: string, batchId: string, actor: OnboardingActor) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const [batch] = (await runner.query(
				`SELECT
					EXISTS (SELECT 1 FROM onboarding_events WHERE holding_id = $1 AND type = 'previous_invoices_imported' AND entity_id = $2) AS imported,
					EXISTS (SELECT 1 FROM onboarding_events WHERE holding_id = $1 AND type = 'previous_invoices_reverted' AND entity_id = $2) AS reverted,
					(SELECT COUNT(*) FROM invoices_legacy il WHERE il.holding_id = $1 AND il.import_batch_id = $2
						AND EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)) AS with_history,
					(SELECT COUNT(*) FROM invoices_legacy il WHERE il.holding_id = $1 AND il.import_batch_id = $2 AND il.contract_id IS NOT NULL) AS linked`,
				[holdingId, batchId]
			)) as Row[];

			if (!batch?.imported) throw new NotFoundException('Importación no encontrada');
			if (batch.reverted) throw conflict('already_reverted', 'La importación ya está revertida');
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
			const removed = (await runner.query(`DELETE FROM invoices_legacy WHERE holding_id = $1 AND import_batch_id = $2 RETURNING id`, [
				holdingId,
				batchId,
			])) as Row[];

			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'previous_invoices_reverted',
				entityType: 'invoice_batch',
				entityId: batchId,
				payload: { removed: removed.length },
			});

			return { batch_id: batchId, removed: removed.length };
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

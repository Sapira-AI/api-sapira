import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { setApiWriter, withApiWriter } from './api-writer';
import { resolveUserId } from './contract-drafts.service';
import { normalizePriceSpec, PRICE_COLUMNS, priceSpecFromRow } from './price-rows';
import { isMetered, type PriceSpec, validatePriceSpec } from './pricing-engine';

import type { CreatePriceDto, NewPriceVersionDto, PriceSortField, QueryPricesDto, UpdatePriceDto } from './dtos/price.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

const DEFAULT_LIMIT = 25;
/** Contratos que muestra el detalle (`contracts[]`); el total va en `contracts_count`. */
export const PRICE_DETAIL_CONTRACTS_LIMIT = 50;

export const PRICE_NOT_FOUND_MESSAGE = 'Precio de catálogo no encontrado';
export const PRICE_NOT_DRAFT_MESSAGE = 'Solo se edita un precio en borrador: crea una versión nueva para cambiar uno publicado';
export const PRICE_ALREADY_PUBLISHED_MESSAGE = 'El precio ya está publicado';
export const PRICE_ARCHIVED_MESSAGE = 'El precio está archivado: crea una versión nueva';
export const PRICE_IN_USE_WARNING = (count: number) =>
	`${count} contrato(s) usan este precio: conservan su copia y siguen facturando igual; solo deja de poder elegirse en contratos nuevos`;

/** Ordenes permitidos de `GET /prices` → expresión SQL (el alias `contracts_count` sale del SELECT). */
export const PRICE_SORT_SQL: Record<PriceSortField, string> = {
	name: 'p.name',
	product_name: 'pr.name',
	currency: 'p.currency',
	model: 'p.model',
	version: 'p.version',
	status: 'p.status',
	contracts_count: 'contracts_count',
	updated_at: 'p.updated_at',
};

/**
 * Contratos no eliminados que usan el precio: el ítem apunta a la fila (`price_id`, no debería en catálogo) o a una copia
 * `owner = contract` cuyo `list_price_id` es el catálogo (etapa 3: el contrato nunca apunta al catálogo directo).
 */
const CONTRACTS_USING = `FROM contract_items ci
	JOIN contracts c ON c.id = ci.contract_id AND c.deleted_at IS NULL
	LEFT JOIN prices cp ON cp.id = ci.price_id
	WHERE (ci.price_id = p.id OR cp.list_price_id = p.id)`;

/** SELECT del catálogo (alias `p` = prices, `pr` = products, `bm` = billable_metrics). */
const CATALOG_SELECT = `p.id, p.name, p.product_id, pr.name AS product_name, p.currency, p.model, p.quantity_type, p.version, p.status,
	p.supersedes_price_id, p.notes, p.published_at, p.archived_at, p.created_at, p.updated_at,
	bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit,
	${PRICE_COLUMNS},
	(SELECT COUNT(DISTINCT c.id) ${CONTRACTS_USING}) AS contracts_count`;
const CATALOG_FROM = `FROM prices p
	JOIN products pr ON pr.id = p.product_id
	LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id`;

/**
 * Catálogo de precios versionado (Pricing v2 etapa 3, spec §2.2 y §5): `prices.owner = catalog` por holding. Una versión
 * publicada no se edita: se crea la siguiente (`version + 1`, `supersedes_price_id`) y al publicarla la anterior queda
 * `archived`. Los contratos guardan su **copia** (`owner = contract`, `list_price_id`), así publicar o archivar nunca toca
 * contratos firmados. Vive en el módulo de contratos hasta que exista un módulo de pricing.
 */
@Injectable()
export class PricesService {
	constructor(private readonly dataSource: DataSource) {}

	/** Vista pública de una fila del catálogo (lista y detalle). */
	static toView(row: Row) {
		return {
			id: String(row.id),
			name: String(row.name ?? ''),
			product_id: String(row.product_id),
			product_name: toText(row.product_name),
			currency: String(row.currency ?? ''),
			model: String(row.model ?? ''),
			quantity_type: String(row.quantity_type ?? 'fixed'),
			billable_metric: row.metric_id
				? { id: String(row.metric_id), code: toText(row.metric_code), name: toText(row.metric_name), unit: toText(row.metric_unit) }
				: null,
			version: toNumber(row.version) || 1,
			status: String(row.status ?? 'draft'),
			supersedes_price_id: toText(row.supersedes_price_id),
			contracts_count: toNumber(row.contracts_count),
			notes: toText(row.notes),
			published_at: iso(row.published_at),
			archived_at: iso(row.archived_at),
			created_at: iso(row.created_at),
			updated_at: iso(row.updated_at),
			spec: priceSpecFromRow(row)!,
		};
	}

	// ---------------------------------------------------------------- lectura

	/** `GET /prices`: catálogo del holding, filtrado, ordenado (lista blanca) y paginado `{ data, total, currentPage, pages, limit }`. */
	async list(holdingId: string, query: QueryPricesDto) {
		const limit = query.limit ?? DEFAULT_LIMIT;
		const page = query.page ?? 1;
		const params: unknown[] = [holdingId];
		const where: string[] = [`p.holding_id = $1`, `p.owner = 'catalog'`];
		const add = (clause: string, value: unknown) => {
			params.push(value);
			where.push(clause.replace('?', `$${params.length}`));
		};

		if (query.status && query.status !== 'all') add(`p.status = ?`, query.status);
		if (query.product_id) add(`p.product_id = ?::uuid`, query.product_id);
		if (query.currency) add(`p.currency = ?`, query.currency);
		if (query.model) add(`p.model = ?`, query.model);
		if (query.search?.trim()) {
			params.push(`%${query.search.trim()}%`);
			where.push(`(p.name ILIKE $${params.length} OR pr.name ILIKE $${params.length})`);
		}
		const order = `${PRICE_SORT_SQL[query.sortBy ?? 'updated_at']} ${query.sortOrder === 'asc' ? 'ASC' : 'DESC'}`;
		const from = `${CATALOG_FROM} WHERE ${where.join(' AND ')}`;
		const [[count], rows] = await Promise.all([
			this.dataSource.query(`SELECT COUNT(*) AS total ${from}`, params) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT ${CATALOG_SELECT} ${from} ORDER BY ${order}, p.version DESC, p.id LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
				params
			) as Promise<Row[]>,
		]);
		const total = toNumber(count?.total);

		return { data: rows.map(PricesService.toView), total, currentPage: page, pages: Math.max(1, Math.ceil(total / limit)), limit };
	}

	private async row(db: Queryable, id: string, holdingId: string): Promise<Row | undefined> {
		const [row] = (await db.query(`SELECT ${CATALOG_SELECT} ${CATALOG_FROM} WHERE p.id = $1 AND p.holding_id = $2 AND p.owner = 'catalog'`, [
			id,
			holdingId,
		])) as Row[];

		return row;
	}

	/** `GET /prices/:id`: detalle + `versions[]` (cadena del mismo producto y moneda) + `contracts[]` que lo usan (hasta 50). */
	async get(id: string, holdingId: string) {
		const row = await this.row(this.dataSource, id, holdingId);

		if (!row) throw new NotFoundException(PRICE_NOT_FOUND_MESSAGE);
		const view = PricesService.toView(row);
		const [versions, contracts] = await Promise.all([
			this.dataSource.query(
				`SELECT p.id, p.name, p.version, p.status, p.supersedes_price_id, p.published_at, p.archived_at, p.updated_at,
					(SELECT COUNT(DISTINCT c.id) ${CONTRACTS_USING}) AS contracts_count
				FROM prices p
				WHERE p.holding_id = $1 AND p.owner = 'catalog' AND p.product_id = $2 AND p.currency = $3
				ORDER BY p.version DESC, p.created_at DESC`,
				[holdingId, view.product_id, view.currency]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT DISTINCT c.id AS contract_id, c.contract_number, c.status AS contract_status, cl.name_commercial AS client_name, ci.id AS item_id
				FROM prices p
				JOIN contract_items ci ON ci.holding_id = p.holding_id
				JOIN contracts c ON c.id = ci.contract_id AND c.deleted_at IS NULL
				LEFT JOIN prices cp ON cp.id = ci.price_id
				LEFT JOIN clients cl ON cl.id = c.client_id
				WHERE p.holding_id = $2 AND p.id = $1 AND (ci.price_id = p.id OR cp.list_price_id = p.id)
				ORDER BY c.contract_number, ci.id
				LIMIT ${PRICE_DETAIL_CONTRACTS_LIMIT}`,
				[id, holdingId]
			) as Promise<Row[]>,
		]);

		return {
			...view,
			versions: versions.map((version) => ({
				id: String(version.id),
				name: String(version.name ?? ''),
				version: toNumber(version.version) || 1,
				status: String(version.status ?? 'draft'),
				supersedes_price_id: toText(version.supersedes_price_id),
				contracts_count: toNumber(version.contracts_count),
				published_at: iso(version.published_at),
				archived_at: iso(version.archived_at),
				updated_at: iso(version.updated_at),
			})),
			contracts: contracts.map((contract) => ({
				contract_id: String(contract.contract_id),
				contract_number: toText(contract.contract_number),
				contract_status: toText(contract.contract_status),
				client_name: toText(contract.client_name),
				item_id: String(contract.item_id),
			})),
		};
	}

	// ---------------------------------------------------------------- validación

	/** Producto del holding, moneda habilitada, spec coherente y métrica activa si es medido (400 con `errors[]`). */
	private async validate(input: { product_id: string; currency: string; spec: PriceSpec }, holdingId: string): Promise<void> {
		const metricId = isMetered(input.spec) ? (input.spec.billable_metric_id ?? null) : null;
		const [[product], currencies, [metric]] = await Promise.all([
			this.dataSource.query(`SELECT id FROM products WHERE id = $1 AND holding_id = $2`, [input.product_id, holdingId]) as Promise<Row[]>,
			this.dataSource.query(`SELECT code FROM currencies WHERE is_active = true`) as Promise<Row[]>,
			metricId
				? (this.dataSource.query(`SELECT id, status FROM billable_metrics WHERE id = $1 AND holding_id = $2`, [
						metricId,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const errors: FieldError[] = [];

		if (!product) errors.push({ field: 'product_id', message: 'El producto no existe en el catálogo del holding' });
		if (currencies.length && !currencies.some((row) => String(row.code) === input.currency)) {
			errors.push({ field: 'currency', message: `La moneda ${input.currency} no está habilitada` });
		}
		validatePriceSpec(input.spec).forEach((error) => errors.push({ field: `spec.${error.field}`, message: error.message }));
		if (metricId && !metric) errors.push({ field: 'spec.billable_metric_id', message: 'La métrica facturable no existe en el holding' });
		else if (metric && metric.status !== 'active')
			errors.push({ field: 'spec.billable_metric_id', message: 'La métrica facturable está archivada' });
		if (errors.length) throw validationException(errors);
	}

	/** Versión siguiente de la cadena producto + moneda del catálogo (1 si no hay ninguna). */
	private async nextVersion(db: Queryable, holdingId: string, productId: string, currency: string): Promise<number> {
		const [row] = (await db.query(
			`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM prices WHERE holding_id = $1 AND owner = 'catalog' AND product_id = $2 AND currency = $3`,
			[holdingId, productId, currency]
		)) as Row[];

		return toNumber(row?.next) || 1;
	}

	private specParams(spec: PriceSpec): unknown[] {
		return [
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
			spec.invoice_line_mode ?? 'single',
			spec.charge_flat_when_free === true,
		];
	}

	// ---------------------------------------------------------------- escritura

	/** `POST /prices`: borrador con `version = max(producto + moneda) + 1`; `supersedes_price_id` se fija al publicar. */
	async create(dto: CreatePriceDto, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const spec = normalizePriceSpec(dto.spec as PriceSpec);

		await this.validate({ product_id: dto.product_id, currency: dto.currency, spec }, holdingId);
		// Costura: toda escritura v2 corre en una transacción con `sapira.writer = 'api'` (versión y fila en la misma).
		const id = await withApiWriter(this.dataSource, (runner) =>
			this.insertDraft(runner, {
				holdingId,
				userId,
				name: dto.name,
				product_id: dto.product_id,
				currency: dto.currency,
				spec,
				notes: dto.notes ?? null,
				supersedes: null,
			})
		);

		return await this.get(id, holdingId);
	}

	private async insertDraft(
		db: Queryable,
		input: {
			holdingId: string;
			userId: string;
			name: string;
			product_id: string;
			currency: string;
			spec: PriceSpec;
			notes: string | null;
			supersedes: string | null;
		}
	): Promise<string> {
		const version = await this.nextVersion(db, input.holdingId, input.product_id, input.currency);
		const [row] = (await db.query(
			`INSERT INTO prices (
				holding_id, owner, product_id, contract_id, name, currency, model, quantity_type, billable_metric_id,
				unit_amount, tiers, package_size, package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount,
				invoice_line_mode, charge_flat_when_free, status, version, supersedes_price_id, list_price_id, notes, created_by, updated_by
			) VALUES (
				$1, 'catalog', $2, NULL, $3, $4, $5, $6, $7,
				$8, $9::jsonb, $10, $11, $12, $13, $14, $15,
				$16, $17, 'draft', $18, $19, NULL, $20, $21, $21
			) RETURNING id`,
			[
				input.holdingId,
				input.product_id,
				input.name,
				input.currency,
				...this.specParams(input.spec),
				version,
				input.supersedes,
				input.notes,
				input.userId,
			]
		)) as Row[];

		return String(row.id);
	}

	/** `PATCH /prices/:id`: solo borradores (409 si está publicado o archivado). Producto y moneda no cambian. */
	async update(id: string, dto: UpdatePriceDto, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const current = await this.get(id, holdingId);

		if (current.status !== 'draft') throw new ConflictException(PRICE_NOT_DRAFT_MESSAGE);
		const spec = dto.spec ? normalizePriceSpec(dto.spec as PriceSpec) : current.spec;

		await this.validate({ product_id: current.product_id, currency: current.currency, spec }, holdingId);
		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`UPDATE prices SET name = $3, model = $4, quantity_type = $5, billable_metric_id = $6, unit_amount = $7, tiers = $8::jsonb, package_size = $9,
				package_amount = $10, seat_minimum_quantity = $11, free_units = $12, minimum_amount = $13, cap_amount = $14, invoice_line_mode = $15,
				charge_flat_when_free = $16, notes = $17, updated_at = now(), updated_by = $18
			WHERE id = $1 AND holding_id = $2 AND owner = 'catalog' AND status = 'draft'`,
				[id, holdingId, dto.name ?? current.name, ...this.specParams(spec), dto.notes === undefined ? current.notes : dto.notes, userId]
			)
		);

		return await this.get(id, holdingId);
	}

	/**
	 * `POST /prices/:id/publish`: borrador → `active` con `published_at`; la versión activa anterior del mismo producto +
	 * moneda queda `archived` y la nueva la referencia con `supersedes_price_id`. Los contratos con copia de la anterior no
	 * cambian. Una transacción; 409 si ya está publicado o archivado.
	 */
	async publish(id: string, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		let supersededId: string | null = null;

		try {
			const [current] = (await runner.query(
				`SELECT id, status, product_id, currency, supersedes_price_id FROM prices WHERE id = $1 AND holding_id = $2 AND owner = 'catalog' FOR UPDATE`,
				[id, holdingId]
			)) as Row[];

			if (!current) throw new NotFoundException(PRICE_NOT_FOUND_MESSAGE);
			if (current.status === 'active') throw new ConflictException(PRICE_ALREADY_PUBLISHED_MESSAGE);
			if (current.status === 'archived') throw new ConflictException(PRICE_ARCHIVED_MESSAGE);
			const previous = (await runner.query(
				`SELECT id FROM prices WHERE holding_id = $1 AND owner = 'catalog' AND product_id = $2 AND currency = $3 AND status = 'active' AND id <> $4
				ORDER BY version DESC FOR UPDATE`,
				[holdingId, current.product_id, current.currency, id]
			)) as Row[];
			const previousIds = previous.map((row) => String(row.id));

			supersededId = previousIds[0] ?? null;
			if (previousIds.length) {
				await runner.query(
					`UPDATE prices SET status = 'archived', archived_at = now(), updated_at = now(), updated_by = $3 WHERE id = ANY($1::uuid[]) AND holding_id = $2`,
					[previousIds, holdingId, userId]
				);
			}
			await runner.query(
				`UPDATE prices SET status = 'active', published_at = now(), archived_at = NULL, supersedes_price_id = COALESCE($3, supersedes_price_id),
					updated_at = now(), updated_by = $4
				WHERE id = $1 AND holding_id = $2`,
				[id, holdingId, supersededId, userId]
			);
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return { ...(await this.get(id, holdingId)), superseded_price_id: supersededId };
	}

	/**
	 * `POST /prices/:id/archive`: deja de poder elegirse en contratos nuevos. Permitido aunque tenga contratos: conservan
	 * su copia (`warnings[]` lo avisa con `contracts_count`). Idempotente.
	 */
	async archive(id: string, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const current = await this.get(id, holdingId);

		if (current.status !== 'archived') {
			await withApiWriter(this.dataSource, (runner) =>
				runner.query(
					`UPDATE prices SET status = 'archived', archived_at = now(), updated_at = now(), updated_by = $3 WHERE id = $1 AND holding_id = $2 AND owner = 'catalog'`,
					[id, holdingId, userId]
				)
			);
		}
		const detail = await this.get(id, holdingId);

		return { ...detail, warnings: detail.contracts_count > 0 ? [PRICE_IN_USE_WARNING(detail.contracts_count)] : [] };
	}

	/**
	 * `POST /prices/:id/new-version`: copia la versión (publicada o archivada, también un borrador) como borrador con
	 * `version + 1` de la cadena y `supersedes_price_id` = origen; lo que venga en el body reemplaza a la copia.
	 */
	async newVersion(id: string, dto: NewPriceVersionDto, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const source = await this.get(id, holdingId);
		const spec = dto.spec ? normalizePriceSpec(dto.spec as PriceSpec) : source.spec;

		await this.validate({ product_id: source.product_id, currency: source.currency, spec }, holdingId);
		const newId = await withApiWriter(this.dataSource, (runner) =>
			this.insertDraft(runner, {
				holdingId,
				userId,
				name: dto.name ?? source.name,
				product_id: source.product_id,
				currency: source.currency,
				spec,
				notes: dto.notes === undefined ? source.notes : dto.notes,
				supersedes: source.id,
			})
		);

		return await this.get(newId, holdingId);
	}
}

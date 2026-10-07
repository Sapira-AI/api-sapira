/**
 * Uso de los modelos de precio en el holding (Planes y precios › Modelos de precio, decisión de Domi 07-10) y lista de
 * precios propios de los contratos (`owner = contract`, Precios › En contratos). Solo lectura. Piezas puras (SQL y
 * armado de la respuesta) para probarlas sin base; las consultas las corre `PricesService`.
 */

import { PRICE_COLUMNS, priceSpecFromRow } from './price-rows';
import { PRICE_MODELS, PRICE_QUANTITY_TYPES } from './pricing-engine';

import type { ContractPriceSortField } from './dtos/price.dto';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

/** Modelo de los ítems vivos sin precio (`price_id` nulo): precio fijo heredado de antes de Pricing v2. */
export const NO_MODEL = 'none' as const;

export type UsageModel = (typeof PRICE_MODELS)[number] | typeof NO_MODEL;

export interface PriceModelUsage {
	model: UsageModel;
	quantity_type: (typeof PRICE_QUANTITY_TYPES)[number];
	/** Ítems vivos (fin y churn nulos o desde hoy) de contratos no eliminados ni cancelados con un precio de este modelo. */
	items_in_use: number;
	/** Contratos distintos de esos ítems. */
	contracts: number;
	/** Precios de catálogo no archivados (borrador o activo). */
	catalog_prices: number;
	/** Precios propios de contratos no eliminados (cualquier estado del contrato): el total de "En contratos". */
	contract_prices: number;
}

/**
 * Ítems vivos. "Vivo" = el ítem no terminó (`end_date` nulo o ≥ hoy) ni tiene churn efectivo (`churn_date` nulo o posterior
 * a hoy), en un contrato no eliminado y no Cancelado (En revisión cuenta: es un contrato que se va a facturar).
 * `$1` = holding, `$2` = hoy (zona del holding por defecto, Santiago).
 */
const LIVE_ITEMS = `FROM contract_items ci
	JOIN contracts c ON c.id = ci.contract_id AND c.deleted_at IS NULL AND c.status IS DISTINCT FROM 'Cancelado'
	LEFT JOIN prices p ON p.id = ci.price_id
	WHERE ci.holding_id = $1
		AND (ci.end_date IS NULL OR ci.end_date >= $2::date)
		AND (ci.churn_date IS NULL OR ci.churn_date > $2::date)`;

/** Ítems vivos por modelo y tipo de cantidad (grilla). Los ítems sin precio salen como `none`/`fixed`. */
export const USAGE_ITEMS_SQL = `SELECT COALESCE(p.model, '${NO_MODEL}') AS model, COALESCE(p.quantity_type, 'fixed') AS quantity_type,
		COUNT(*) AS items_in_use, COUNT(DISTINCT ci.contract_id) AS contracts
	${LIVE_ITEMS}
	GROUP BY 1, 2`;

/** Ítems vivos por modelo, sin separar la cantidad: los contratos distintos no se pueden sumar desde la grilla. */
export const USAGE_BY_MODEL_SQL = `SELECT COALESCE(p.model, '${NO_MODEL}') AS model, COUNT(*) AS items_in_use, COUNT(DISTINCT ci.contract_id) AS contracts
	${LIVE_ITEMS}
	GROUP BY 1`;

/**
 * Ítems vivos **con precio** por tipo de cantidad (fija o por consumo) y el total (`is_total = 1`): contratos distintos en
 * cada caso, sin doble conteo.
 */
export const USAGE_BY_QUANTITY_SQL = `SELECT p.quantity_type, GROUPING(p.quantity_type) AS is_total, COUNT(*) AS items_in_use,
		COUNT(DISTINCT ci.contract_id) AS contracts
	${LIVE_ITEMS} AND p.id IS NOT NULL
	GROUP BY GROUPING SETS ((p.quantity_type), ())`;

/** Precios por modelo, tipo de cantidad y dueño (catálogo no archivado; contrato con contrato no eliminado). `$1` = holding. */
export const USAGE_PRICES_SQL = `SELECT p.model, p.quantity_type, p.owner, COUNT(*) AS prices
	FROM prices p
	LEFT JOIN contracts c ON c.id = p.contract_id
	WHERE p.holding_id = $1
		AND ((p.owner = 'catalog' AND p.status <> 'archived') OR (p.owner = 'contract' AND c.deleted_at IS NULL))
	GROUP BY 1, 2, 3`;

const emptyUsage = () => ({ items_in_use: 0, contracts: 0 });

/**
 * Respuesta de `GET /prices/models/usage`. `models` = grilla completa modelo × tipo de cantidad (orden fijo, con ceros)
 * más `none`/`fixed` al final; `by_model` y `by_quantity_type` traen los contratos distintos sin doble conteo; `totals`
 * = ítems vivos con precio y sus contratos, y los precios de catálogo y de contratos sumados.
 */
export function buildModelsUsage(items: Row[], prices: Row[], byModel: Row[] = [], byQuantity: Row[] = []) {
	const key = (model: unknown, quantity: unknown) => `${String(model)}|${String(quantity)}`;
	const grid = new Map<string, PriceModelUsage>();
	const zero = () => ({ ...emptyUsage(), catalog_prices: 0, contract_prices: 0 });

	for (const model of PRICE_MODELS)
		for (const quantity_type of PRICE_QUANTITY_TYPES) grid.set(key(model, quantity_type), { model, quantity_type, ...zero() });
	grid.set(key(NO_MODEL, 'fixed'), { model: NO_MODEL, quantity_type: 'fixed', ...zero() });

	for (const row of items) {
		const entry = grid.get(key(row.model, row.quantity_type));

		if (!entry) continue;
		entry.items_in_use += toNumber(row.items_in_use);
		entry.contracts += toNumber(row.contracts);
	}
	for (const row of prices) {
		const entry = grid.get(key(row.model, row.quantity_type));

		if (!entry) continue;
		if (row.owner === 'catalog') entry.catalog_prices += toNumber(row.prices);
		else if (row.owner === 'contract') entry.contract_prices += toNumber(row.prices);
	}
	const models = [...grid.values()];
	const sum = (field: 'catalog_prices' | 'contract_prices') => models.reduce((total, row) => total + row[field], 0);
	const usageOf = (row: Row | undefined) => ({ items_in_use: toNumber(row?.items_in_use), contracts: toNumber(row?.contracts) });
	const total = byQuantity.find((row) => toNumber(row.is_total) === 1);

	return {
		models,
		by_model: [...PRICE_MODELS, NO_MODEL].map((model) => ({ model, ...usageOf(byModel.find((row) => row.model === model)) })),
		by_quantity_type: PRICE_QUANTITY_TYPES.map((quantity_type) => ({
			quantity_type,
			...usageOf(byQuantity.find((row) => toNumber(row.is_total) !== 1 && row.quantity_type === quantity_type)),
		})),
		totals: {
			/** Ítems vivos con precio (sin contar `none`) y contratos distintos que los tienen. */
			...usageOf(total),
			catalog_prices: sum('catalog_prices'),
			contract_prices: sum('contract_prices'),
		},
	};
}

/** Orden de `GET /prices/contract-prices` → expresión SQL (lista blanca). */
export const CONTRACT_PRICE_SORT_SQL: Record<ContractPriceSortField, string> = {
	contract_number: 'c.contract_number',
	client_name: 'cl.name_commercial',
	product_name: 'pr.name',
	model: 'p.model',
	items_count: 'items_count',
	updated_at: 'p.updated_at',
};

/** FROM de la lista "En contratos": precio propio + contrato no eliminado + cliente + producto + métrica. `$1` = holding. */
export const CONTRACT_PRICES_FROM = `FROM prices p
	JOIN contracts c ON c.id = p.contract_id AND c.deleted_at IS NULL
	JOIN products pr ON pr.id = p.product_id
	LEFT JOIN clients cl ON cl.id = c.client_id
	LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id`;

/** SELECT de la lista; necesita el lateral `derivedStatusLateral` (alias `ds`, estado mostrado del contrato como en la lista de Contratos). */
export const CONTRACT_PRICES_SELECT = `p.id, p.name, p.currency, p.model, p.quantity_type, p.updated_at,
	c.id AS contract_id, c.contract_number, ds.derived_status AS contract_status,
	c.client_id, cl.name_commercial AS client_name, p.product_id, pr.name AS product_name,
	bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit,
	${PRICE_COLUMNS},
	(SELECT COUNT(*) FROM contract_items ci WHERE ci.price_id = p.id) AS items_count,
	ARRAY(SELECT ci.id::text FROM contract_items ci WHERE ci.price_id = p.id ORDER BY ci.start_date DESC NULLS LAST, ci.id) AS item_ids`;

/** Vista pública de un precio propio de contrato. `spec` trae los campos del modelo (`unit_amount`, `tiers`, …) para resumirlo en el front. */
export function contractPriceView(row: Row) {
	return {
		id: String(row.id),
		name: toText(row.name),
		currency: String(row.currency ?? ''),
		model: String(row.model ?? ''),
		quantity_type: String(row.quantity_type ?? 'fixed'),
		contract: { id: String(row.contract_id), number: toText(row.contract_number), status: toText(row.contract_status) },
		client: row.client_id ? { id: String(row.client_id), name: toText(row.client_name) } : null,
		product: { id: String(row.product_id), name: toText(row.product_name) },
		billable_metric: row.metric_id
			? { id: String(row.metric_id), code: toText(row.metric_code), name: toText(row.metric_name), unit: toText(row.metric_unit) }
			: null,
		/** Copia de un precio de catálogo (null = precio creado en el contrato o por migración). */
		list_price_id: toText(row.price_list_price_id),
		items_count: toNumber(row.items_count),
		/** Ítems del contrato que usan el precio, el de inicio más reciente primero ("Cambiar modelo" en Precios › En contratos abre con él). */
		item_ids: Array.isArray(row.item_ids) ? row.item_ids.map(String) : [],
		updated_at: iso(row.updated_at),
		spec: priceSpecFromRow(row)!,
	};
}

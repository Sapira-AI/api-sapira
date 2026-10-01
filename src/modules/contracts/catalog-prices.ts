/**
 * Precios de catálogo (Pricing v2 etapa 3, `docs/v2-rediseno/spec-pricing-v2.md` §2.2 y §5): lectura de las filas
 * `prices.owner = catalog` que un ítem referencia con `price_id` y las reglas para copiarlas al contrato. Lo comparten el alta
 * (`POST/PUT /contracts`) y las modificaciones (`item_add`). El contrato nunca apunta a la fila del catálogo: recibe su propia
 * fila `owner = contract` con `list_price_id` = catálogo, así una versión nueva del catálogo no altera contratos ya creados.
 */

import type { FieldError } from '@/core/utils/validation-errors';

import { priceSpecFromRow } from './price-rows';

import type { PriceSpec } from './pricing-engine';
import type { DataSource, QueryRunner } from 'typeorm';

type Queryable = Pick<DataSource, 'query'> | QueryRunner;
type Row = Record<string, unknown>;

/** Fila de catálogo ya leída, con su spec normalizado para copiar al contrato. */
export interface CatalogPrice {
	id: string;
	name: string;
	product_id: string;
	currency: string;
	status: string;
	version: number;
	spec: PriceSpec;
}

export const CATALOG_PRICE_MESSAGES = {
	both: 'Elige el precio de catálogo o el modelo de precio del ítem, no ambos',
	missing: 'El precio de catálogo no existe en el holding',
	draft: 'El precio de catálogo no está publicado: publícalo o elige la versión vigente',
	archived: 'El precio de catálogo está archivado: elige la versión vigente',
	product: 'El precio de catálogo es de otro producto',
	currency: (priceCurrency: string, contractCurrency: string) =>
		`El precio de catálogo es en ${priceCurrency} y el contrato en ${contractCurrency}: elige uno en la moneda del contrato`,
} as const;

/** Ids de catálogo que referencian los ítems (`price_id`), sin repetidos. */
export const catalogPriceIds = (items: Array<{ price_id?: unknown }>) => [
	...new Set(items.map((item) => item.price_id).filter((id): id is string => typeof id === 'string' && id.length > 0)),
];

/** Filas `owner = catalog` del holding por id (las que no existen o son de otro holding simplemente no vienen). */
export async function loadCatalogPrices(db: Queryable, ids: string[], holdingId: string): Promise<Map<string, CatalogPrice>> {
	if (!ids.length) return new Map();
	const rows = (await db.query(
		`SELECT id, name, product_id, currency, status, version, model, quantity_type, billable_metric_id, unit_amount, tiers, package_size,
			package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount, invoice_line_mode, charge_flat_when_free
		FROM prices WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND owner = 'catalog'`,
		[ids, holdingId]
	)) as Row[];

	return new Map(
		rows.map((row) => [
			String(row.id),
			{
				id: String(row.id),
				name: String(row.name ?? ''),
				product_id: String(row.product_id),
				currency: String(row.currency ?? '').toUpperCase(),
				status: String(row.status ?? ''),
				version: Number(row.version ?? 1) || 1,
				spec: priceSpecFromRow(row, '')!,
			},
		])
	);
}

/**
 * Errores por campo al referenciar un precio de catálogo desde un ítem (`field` = prefijo del ítem, ej. `items.0`): debe
 * existir en el holding, estar `active`, ser del mismo producto y de la moneda del contrato, y no venir junto a un modelo inline.
 * La regla medido + Anticipado la aplica quien llama (misma que el precio inline).
 */
export function catalogPriceErrors(input: {
	field: string;
	catalog: CatalogPrice | undefined;
	inline: boolean;
	product_id: string;
	contract_currency: string;
}): FieldError[] {
	const field = `${input.field}.price_id`;
	const errors: FieldError[] = [];

	if (input.inline) errors.push({ field, message: CATALOG_PRICE_MESSAGES.both });
	if (!input.catalog) return [...errors, { field, message: CATALOG_PRICE_MESSAGES.missing }];
	if (input.catalog.status === 'draft') errors.push({ field, message: CATALOG_PRICE_MESSAGES.draft });
	else if (input.catalog.status !== 'active') errors.push({ field, message: CATALOG_PRICE_MESSAGES.archived });
	if (input.catalog.product_id !== input.product_id) errors.push({ field, message: CATALOG_PRICE_MESSAGES.product });
	const contractCurrency = input.contract_currency.toUpperCase();

	if (input.catalog.currency !== contractCurrency) {
		errors.push({ field, message: CATALOG_PRICE_MESSAGES.currency(input.catalog.currency, contractCurrency) });
	}

	return errors;
}

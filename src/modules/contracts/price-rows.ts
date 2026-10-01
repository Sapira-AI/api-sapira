/**
 * Puente entre las filas de `prices` (Pricing v2 §2.2) y el `PriceSpec` del motor. Sin base: recibe filas ya leídas y
 * devuelve valores listos para el INSERT. Lo usan el alta (C1/PUT), la activación (C2), el 360 y el consumo.
 */

import {
	DEFAULT_INVOICE_LINE_MODE,
	type InvoiceLineMode,
	type PriceModel,
	type PriceQuantityType,
	type PriceSpec,
	type PriceTier,
} from './pricing-engine';

type Row = Record<string, unknown>;

/** Columnas de `prices` que exponen los servicios (alias `p`). */
export const PRICE_COLUMNS = `p.id AS price_id, p.name AS price_name, p.version AS price_version, p.status AS price_status,
	p.model AS price_model, p.quantity_type AS price_quantity_type, p.billable_metric_id AS price_billable_metric_id,
	p.unit_amount AS price_unit_amount, p.tiers AS price_tiers, p.package_size AS price_package_size, p.package_amount AS price_package_amount,
	p.seat_minimum_quantity AS price_seat_minimum_quantity, p.free_units AS price_free_units, p.minimum_amount AS price_minimum_amount,
	p.cap_amount AS price_cap_amount, p.invoice_line_mode AS price_invoice_line_mode, p.charge_flat_when_free AS price_charge_flat_when_free,
	p.list_price_id AS price_list_price_id`;

const toNumber = (value: unknown): number | null => {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);

	return Number.isFinite(parsed) ? parsed : null;
};

const toTiers = (value: unknown): PriceTier[] | null => {
	const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

	if (!Array.isArray(raw)) return null;

	return raw.map((tier: Row) => ({
		from: toNumber(tier.from) ?? 0,
		to: tier.to === null || tier.to === undefined ? null : toNumber(tier.to),
		per_unit_amount: toNumber(tier.per_unit_amount) ?? 0,
		flat_amount: toNumber(tier.flat_amount) ?? 0,
	}));
};

/** `PriceSpec` desde una fila leída con `PRICE_COLUMNS` (prefijo `price_`), o desde la fila cruda de `prices` (sin prefijo). */
export function priceSpecFromRow(row: Row, prefix = 'price_'): PriceSpec | null {
	const get = (name: string) => row[`${prefix}${name}`] ?? (prefix ? undefined : row[name]);

	if (!get('model') && !row[`${prefix}id`]) return null;

	return {
		model: String(get('model')) as PriceModel,
		quantity_type: String(get('quantity_type')) as PriceQuantityType,
		billable_metric_id: get('billable_metric_id') ? String(get('billable_metric_id')) : null,
		unit_amount: toNumber(get('unit_amount')),
		tiers: toTiers(get('tiers')),
		package_size: toNumber(get('package_size')),
		package_amount: toNumber(get('package_amount')),
		seat_minimum_quantity: toNumber(get('seat_minimum_quantity')),
		free_units: toNumber(get('free_units')),
		minimum_amount: toNumber(get('minimum_amount')),
		cap_amount: toNumber(get('cap_amount')),
		invoice_line_mode: (get('invoice_line_mode') ? String(get('invoice_line_mode')) : DEFAULT_INVOICE_LINE_MODE) as InvoiceLineMode,
		charge_flat_when_free: get('charge_flat_when_free') === true,
	};
}

/** Spec normalizado (números, tramos con `flat_amount`, nulls explícitos): lo que se guarda y lo que se compara. */
export function normalizePriceSpec(spec: PriceSpec): PriceSpec {
	const tiers = Array.isArray(spec.tiers)
		? spec.tiers.map((tier) => ({
				from: Number(tier.from),
				to: tier.to === null || tier.to === undefined ? null : Number(tier.to),
				per_unit_amount: Number(tier.per_unit_amount),
				flat_amount: Number(tier.flat_amount ?? 0) || 0,
			}))
		: null;
	const uses = (models: PriceModel[]) => models.includes(spec.model);

	return {
		model: spec.model,
		quantity_type: spec.quantity_type,
		billable_metric_id: spec.quantity_type === 'metered' ? (spec.billable_metric_id ?? null) : null,
		unit_amount: uses(['standard', 'seat']) ? toNumber(spec.unit_amount) : null,
		tiers: uses(['graduated', 'volume']) ? tiers : null,
		package_size: spec.model === 'package' ? toNumber(spec.package_size) : null,
		package_amount: spec.model === 'package' ? toNumber(spec.package_amount) : null,
		seat_minimum_quantity: spec.model === 'seat' ? (toNumber(spec.seat_minimum_quantity) ?? 0) : 0,
		free_units: toNumber(spec.free_units) ?? 0,
		minimum_amount: toNumber(spec.minimum_amount),
		cap_amount: toNumber(spec.cap_amount),
		invoice_line_mode: spec.invoice_line_mode ?? DEFAULT_INVOICE_LINE_MODE,
		charge_flat_when_free: uses(['graduated', 'volume']) && spec.charge_flat_when_free === true,
	};
}

/** Igualdad de dos specs ya normalizados (para decidir si el PUT crea una versión nueva). */
export const samePriceSpec = (a: PriceSpec | null, b: PriceSpec | null) =>
	JSON.stringify(a ? normalizePriceSpec(a) : null) === JSON.stringify(b ? normalizePriceSpec(b) : null);

/** Resumen público del precio de un ítem (360, formulario, consumo). */
export function priceSummaryFromRow(row: Row) {
	if (!row.price_id) return null;

	return {
		id: String(row.price_id),
		name: row.price_name === null || row.price_name === undefined ? null : String(row.price_name),
		version: Number(row.price_version ?? 1) || 1,
		status: row.price_status === null || row.price_status === undefined ? null : String(row.price_status),
		/** Etapa 3: precio de catálogo del que salió la copia del contrato (null en precios inline). */
		list_price_id: row.price_list_price_id === null || row.price_list_price_id === undefined ? null : String(row.price_list_price_id),
		...priceSpecFromRow(row)!,
	};
}

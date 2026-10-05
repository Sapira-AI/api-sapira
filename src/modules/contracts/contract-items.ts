/**
 * Reglas puras de los ítems del contrato (sin base de datos), para el 360 de Contratos v2.
 *
 * - `deriveItemStatus`: estado del ítem hoy.
 * - `buildItemGroups`: **ítem madre** (estado vigente por producto + cuenta). Port exacto de
 *   `sapira-ai/src/components/contratos/detail/components/ContractItemsSummary.tsx` y del §10 de
 *   `docs/v2-rediseno/manual-modificaciones-contratos.md`.
 *
 * Todas las fechas son `YYYY-MM-DD` (texto), así se comparan como string sin problemas de zona horaria.
 */

import type { priceSummaryFromRow } from './price-rows';

export type ContractItemStatus = 'active' | 'future' | 'ended' | 'churned' | 'renewed';

export interface ContractItem {
	id: string;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	item_type: string | null;
	categoria: string | null;
	unit_of_measure: string | null;
	quantity: number | null;
	unit_price: number | null;
	price_entry_mode: string | null;
	annual_unit_price: number | null;
	discount_type: string | null;
	discount_value: number | null;
	monthly_price: number | null;
	billing_period_price: number | null;
	final_price: number | null;
	term_months: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
	is_recurring: boolean;
	start_date: string | null;
	end_date: string | null;
	booking_date: string | null;
	churn_date: string | null;
	related_item_id: string | null;
	renews_item_id: string | null;
	renewed_by_item_id: string | null;
	auto_renew: boolean;
	currency: string | null;
	/** Ciclo propio del ítem (§9.3.9, `contract_items.billing_anchor_day`); null/ausente = ciclo del contrato. */
	billing_anchor_day?: number | null;
	status: ContractItemStatus;
}

/** Precio del ítem en `GET /contracts/:id/items` (el resto de lectores de ítems no lo cargan). */
export interface PricedItemFields {
	/** Modelo de precio (`contract_items.price_id` → `prices`), mismo shape que `GET /:id/consumption` `items[].price`. */
	price: ItemPrice | null;
	/** Métrica facturable del precio (`prices.billable_metric_id` → `billable_metrics`). */
	metric: ItemMetric | null;
	/** Precio de catálogo del que salió la copia (`prices.list_price_id`), para "Catálogo · <name> v<version>". */
	catalog_price: CatalogPriceRef | null;
	/** `true` si el ítem tiene precio declarado: `unit_price` es el unitario mensual equivalente guardado, no el del modelo. */
	uses_price_model: boolean;
	/** Pausas del ítem (`contract_item_pauses`, spec modificaciones §9.3.3), todas las del ítem; `active_today` = cubre hoy. */
	pauses?: Array<{
		id: string;
		pause_start: string;
		pause_end: string | null;
		extend_term: boolean;
		status: string;
		reason: string | null;
		pause_event_id: string | null;
		resume_event_id: string | null;
		active_today: boolean;
	}>;
}

export interface PricedContractItem extends ContractItem, PricedItemFields {}

export type ItemPrice = NonNullable<ReturnType<typeof priceSummaryFromRow>>;

export interface ItemMetric {
	id: string;
	code: string;
	name: string;
	unit: string;
	aggregation: string;
}

export interface CatalogPriceRef {
	id: string;
	name: string | null;
	version: number;
}

/** Línea de una factura Por Emitir activa del contrato, para cruzar el ítem madre con la próxima factura. */
export interface PendingInvoiceLine {
	invoice_id: string;
	issue_date: string | null;
	contract_item_id: string;
	subtotal: number;
}

export interface ItemGroup {
	key: string;
	product_name: string;
	account: string | null;
	item_type: string | null;
	unit_of_measure: string | null;
	billing_frequency: string | null;
	billing_method: string | null;
	quantity: number | null;
	mrr: number;
	amount_per_invoice: number;
	unit_effective: number | null;
	currency: string;
	start_date: string | null;
	end_date: string | null;
	item_ids: string[];
	next_invoice: { id: string; issue_date: string | null; amount: number; matches: boolean } | null;
	/** Precio común de los ítems vigentes del grupo (todos con el mismo `price.id`); si difieren o no tienen, `null`. */
	price: ItemPrice | null;
	metric: ItemMetric | null;
	catalog_price: CatalogPriceRef | null;
	/** Algún ítem vigente del grupo tiene modelo de precio: el unitario efectivo (MRR ÷ cantidad) no es "c/u". */
	uses_price_model: boolean;
}

type ItemForStatus = Pick<ContractItem, 'churn_date' | 'categoria' | 'renewed_by_item_id' | 'start_date' | 'end_date'>;

/**
 * Estado del ítem hoy: churned si tiene `churn_date` o es un ítem CHURN; renewed si otro ítem lo renovó y ya
 * terminó; future si aún no inicia; ended si ya terminó; si no, active.
 */
export const deriveItemStatus = (item: ItemForStatus, today: string): ContractItemStatus => {
	if (item.churn_date || item.categoria === 'CHURN') return 'churned';
	if (item.renewed_by_item_id && item.end_date && item.end_date < today) return 'renewed';
	if (item.start_date && item.start_date > today) return 'future';
	if (item.end_date && item.end_date < today) return 'ended';

	return 'active';
};

type GroupableItem = Pick<
	ContractItem,
	| 'id'
	| 'product_name'
	| 'account'
	| 'item_type'
	| 'categoria'
	| 'unit_of_measure'
	| 'quantity'
	| 'monthly_price'
	| 'billing_period_price'
	| 'billing_frequency'
	| 'billing_method'
	| 'is_recurring'
	| 'start_date'
	| 'end_date'
	| 'churn_date'
	| 'related_item_id'
	| 'currency'
>;

const num = (value: unknown) => Number(value) || 0;
/** Ajuste (delta) = categoría UPSELL, DOWNSELL o el espejo CHURN de una baja total. */
const isDelta = (item: GroupableItem) => item.categoria === 'UPSELL' || item.categoria === 'DOWNSELL' || item.categoria === 'CHURN';
/** Vigente = sin churn ya efectivo y sin fin pasado (mismo criterio que ContractItemsSummary). */
const isCurrent = (item: GroupableItem, today: string) => {
	if (item.churn_date && item.churn_date <= today) return false;

	return !item.end_date || item.end_date >= today;
};
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Ítem madre: una fila por producto + cuenta recurrente **vigente** (la cuenta separa aunque el producto coincida).
 *
 * - Ámbito = ítems vigentes ya iniciados (un ajuste o renovación con inicio futuro aún no cuenta). Si ninguno inició,
 *   los vigentes (igual que la app actual).
 * - Cantidad = Σ cantidad de los ítems base + por cada ajuste: si es de **precio** (su cantidad es igual a la de su
 *   ítem relacionado) aporta 0; si no, UPSELL suma y DOWNSELL resta. Si el total no es positivo, la del ítem base más
 *   reciente.
 * - MRR = Σ `monthly_price`; monto por factura = Σ `billing_period_price`; unitario efectivo = MRR ÷ cantidad.
 * - Próxima factura = la Por Emitir activa más próxima con líneas de los ítems del grupo; `matches` si su monto
 *   difiere del monto por factura en 0,05 o menos.
 *
 * Los no recurrentes y los grupos sin ítems vigentes no forman grupo: el front los muestra desde `items`.
 */
export const buildItemGroups = <T extends GroupableItem>(
	items: T[],
	today: string,
	pendingLines: PendingInvoiceLine[] = [],
	/** Precio de cada ítem (solo `GET /:id/items`): el grupo lo resume si todos sus vigentes comparten `price.id`. */
	priceOf: (item: T) => Partial<PricedItemFields> | undefined = () => undefined
): ItemGroup[] => {
	const quantityById = new Map(items.map((item) => [item.id, Number(item.quantity)]));
	const byId = new Map(items.map((item) => [item.id, item]));
	const byKey = new Map<string, T[]>();

	for (const item of items) {
		if (item.is_recurring === false) continue;
		// El espejo de una baja (ítem CHURN/DOWNSELL con `related_item_id`) sigue a su base: si la base ya tiene churn efectivo,
		// el espejo tampoco está vigente (si no, el grupo mostraría MRR negativo; manual §10). Un downsell parcial (base viva) sí cuenta.
		const base = item.related_item_id ? byId.get(item.related_item_id) : undefined;

		if ((item.categoria === 'CHURN' || item.categoria === 'DOWNSELL') && base?.churn_date && base.churn_date <= today) continue;
		const key = `${item.product_name || '—'}|${(item.account || '').trim()}`;

		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key)!.push(item);
	}

	const groups: ItemGroup[] = [];

	for (const [key, groupItems] of byKey) {
		const current = groupItems.filter((item) => isCurrent(item, today));

		if (current.length === 0) continue;
		const started = current.filter((item) => !item.start_date || item.start_date <= today);
		const scope = started.length > 0 ? started : current;
		const bases = scope.filter((item) => !isDelta(item));
		const latestBase = [...bases].sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''))[0];
		const reference = latestBase ?? scope[0];

		const mrr = scope.reduce((sum, item) => sum + num(item.monthly_price), 0);
		const perInvoice = scope.reduce((sum, item) => sum + num(item.billing_period_price), 0);
		const quantitySum = scope.reduce((sum, item) => {
			const quantity = num(item.quantity);

			if (!isDelta(item)) return sum + quantity;
			const relatedQuantity = item.related_item_id ? quantityById.get(item.related_item_id) : undefined;
			const isPriceAdjustment =
				relatedQuantity !== undefined && Number.isFinite(relatedQuantity) && Math.abs(quantity - relatedQuantity) < 1e-6;

			if (isPriceAdjustment) return sum;

			return sum + (item.categoria === 'DOWNSELL' || item.categoria === 'CHURN' ? -quantity : quantity);
		}, 0);
		const baseQuantity = latestBase?.quantity === null || latestBase?.quantity === undefined ? null : Number(latestBase.quantity);
		const quantity = quantitySum > 0 ? quantitySum : baseQuantity;

		const ids = new Set(groupItems.map((item) => item.id));
		const lines = pendingLines.filter((line) => ids.has(line.contract_item_id));
		let nextInvoice: ItemGroup['next_invoice'] = null;

		if (lines.length > 0) {
			const earliest = lines.reduce((acc, line) => ((line.issue_date || '9999-12-31') < (acc.issue_date || '9999-12-31') ? line : acc));
			const amount = round2(lines.filter((line) => line.invoice_id === earliest.invoice_id).reduce((sum, line) => sum + num(line.subtotal), 0));

			nextInvoice = { id: earliest.invoice_id, issue_date: earliest.issue_date, amount, matches: Math.abs(amount - perInvoice) <= 0.05 };
		}

		const scopePrices = scope.map((item) => priceOf(item));
		const priceIds = new Set(scopePrices.map((fields) => fields?.price?.id ?? null));
		const shared = priceIds.size === 1 && !priceIds.has(null) ? scopePrices[0] : undefined;

		const startDates = scope.map((item) => item.start_date).filter((date): date is string => !!date);
		const endDates = scope.map((item) => item.end_date).filter((date): date is string => !!date);

		groups.push({
			key,
			product_name: groupItems[0].product_name || '—',
			account: (groupItems[0].account || '').trim() || null,
			item_type: reference.item_type ?? null,
			unit_of_measure: reference.unit_of_measure ?? null,
			billing_frequency: reference.billing_frequency || groupItems[0].billing_frequency || null,
			billing_method: reference.billing_method || groupItems[0].billing_method || null,
			quantity,
			mrr: round2(mrr),
			amount_per_invoice: round2(perInvoice),
			unit_effective: quantity && quantity > 0 ? mrr / quantity : null,
			currency: reference.currency || groupItems[0].currency || 'USD',
			start_date: startDates.length > 0 ? startDates.sort()[0] : null,
			end_date: endDates.length > 0 ? endDates.sort()[0] : null,
			item_ids: groupItems.map((item) => item.id),
			next_invoice: nextInvoice,
			price: shared?.price ?? null,
			metric: shared?.metric ?? null,
			catalog_price: shared?.catalog_price ?? null,
			uses_price_model: scopePrices.some((fields) => Boolean(fields?.price)),
		});
	}

	return groups.sort((a, b) => a.key.localeCompare(b.key));
};

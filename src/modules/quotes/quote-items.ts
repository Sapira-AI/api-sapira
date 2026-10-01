/**
 * Cotizaciones v2 — ítems (mapa §5d): resolución de los valores que se guardan en `quote_items` a partir del DTO y validación de
 * completitud para marcar firmada (§5a). Puro: sin base. Reutiliza el motor de Contratos: `itemPricing` (precio = unitario mensual ×
 * cantidad × plazo, final = precio × (1 − dcto %)), `itemEndDate` (fin = inicio + plazo − 1 día, siempre) y `priceLine`/`PriceSpec`
 * (Pricing v2). Con un `PriceSpec` no estándar, `unit_price` es el **mensual equivalente** (misma regla que Contratos §2f), así el
 * trigger `auto_calculate_pricing_fields` (hoy su réplica `pricingFields`, que escribe la API) deriva `monthly_price`/`billing_period_price` iguales.
 */

import { BILLING_FREQUENCY_MONTHS, type BillingFrequency, itemEndDate, itemPricing, round2 } from '@/modules/contracts/billing-engine';
import { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import { hasPricingModel } from '@/modules/contracts/dtos/create-contract.dto';
import { normalizePriceSpec } from '@/modules/contracts/price-rows';
import { type PricedLine, priceLine, type PriceSpec } from '@/modules/contracts/pricing-engine';

import type { CreateQuoteItemDto } from './dtos/create-quote.dto';

export interface ResolvedQuoteItem {
	key: string;
	dto: CreateQuoteItemDto;
	product_name: string;
	/** Unitario **mensual** (anual / 12 en modo anual; mensual equivalente con modelo de precio). */
	unit_price: number;
	annual_unit_price: number | null;
	price_entry_mode: 'monthly' | 'annual';
	is_recurring: boolean;
	/** Bruto: unitario mensual × cantidad × plazo. */
	price: number;
	discount_pct: number;
	/** Neto: price × (1 − dcto %). */
	final_price: number;
	/** Mensual neto (recurrentes) o final / plazo (una vez). */
	monthly_price: number;
	/** Por período de facturación: mensual × meses de la frecuencia (recurrentes) o el final completo (una vez). */
	billing_period_price: number;
	end_date: string;
	/** Pricing v2: modelo normalizado, o null = standard fijo. */
	price_spec: PriceSpec | null;
	/** Línea tarifada a la cantidad base (solo con modelo de precio). */
	priced: PricedLine | null;
}

/** Resuelve los ítems del DTO con los nombres del catálogo (`products`: id → nombre). Los `price_id` de catálogo ya vienen como `price`. */
export function resolveQuoteItems(items: CreateQuoteItemDto[], products: Map<string, string>): ResolvedQuoteItem[] {
	return items.map((item, index) => {
		const spec = hasPricingModel(item) ? normalizePriceSpec(item.price!) : null;
		// El modo anual solo aplica al precio estándar: con modelo de precio el unitario es el mensual equivalente del motor.
		const annual = item.price_entry_mode === 'annual' && !spec;
		const unitPrice = spec
			? ContractDraftsService.equivalentMonthlyUnit(spec, item)
			: annual
				? round6(Number(item.annual_unit_price ?? 0) / 12)
				: Number(item.unit_price ?? 0);
		const pricing = itemPricing({
			quantity: item.quantity,
			unit_price: unitPrice,
			term_months: item.term_months,
			discount_value: item.discount_value,
		});
		const isRecurring = item.is_recurring !== false;
		const term = Number(item.term_months) || 1;
		const months = BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1;
		const monthly = round2(pricing.final_price / term);

		return {
			key: item.key || `item-${index + 1}`,
			dto: item,
			product_name: item.product_name?.trim() || products.get(item.product_id) || 'Producto',
			unit_price: unitPrice,
			annual_unit_price: annual ? Number(item.annual_unit_price ?? 0) : round6(unitPrice * 12),
			price_entry_mode: annual ? 'annual' : 'monthly',
			is_recurring: isRecurring,
			price: pricing.price,
			discount_pct: pricing.discount_pct,
			final_price: pricing.final_price,
			monthly_price: monthly,
			billing_period_price: isRecurring ? round2(monthly * months) : pricing.final_price,
			end_date: itemEndDate(item.start_date, item.term_months),
			price_spec: spec,
			priced: spec ? priceLine(spec, Number(item.quantity) || 0, item.discount_value ?? 0) : null,
		};
	});
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

/** Totales de una cotización a partir de sus ítems resueltos (lo que se guarda en `quotes.total_amount` y lo que muestra la revisión). */
export function quoteTotals(items: ResolvedQuoteItem[]) {
	const total = round2(items.reduce((sum, item) => sum + item.final_price, 0));
	const mrr = round2(items.filter((item) => item.is_recurring).reduce((sum, item) => sum + item.monthly_price, 0));
	const oneTime = round2(items.filter((item) => !item.is_recurring).reduce((sum, item) => sum + item.final_price, 0));
	const byFrequency = new Map<string, number>();

	for (const item of items) {
		const key = item.is_recurring ? `${item.dto.billing_frequency} ${item.dto.billing_method}` : 'Una vez';

		byFrequency.set(key, round2((byFrequency.get(key) ?? 0) + item.billing_period_price));
	}

	return {
		total_amount: total,
		mrr,
		one_time: oneTime,
		by_frequency: [...byFrequency.entries()].map(([label, amount]) => ({ label, amount })),
	};
}

/** Fila de `quote_items` tal como se lee para validar (subset). */
export interface StoredQuoteItem {
	id: string;
	product_id: string | null;
	product_name: string | null;
	final_price: number | null;
	start_date: string | null;
	end_date: string | null;
	term_months: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
	price_id?: string | null;
	price_model?: string | null;
}

/**
 * Ítems completos para marcar firmada (§5a): producto del catálogo, precio > 0 o modelo de precio, inicio, plazo o fin,
 * frecuencia y método. Devuelve `errors[{ field: items.N.<campo>, message }]` (vacío si todo está).
 */
export function itemsIncomplete(items: StoredQuoteItem[]): Array<{ field: string; message: string }> {
	const errors: Array<{ field: string; message: string }> = [];

	items.forEach((item, index) => {
		const name = item.product_name?.trim() || `ítem ${index + 1}`;
		const field = (column: string) => `items.${index}.${column}`;

		if (!item.product_id) errors.push({ field: field('product_id'), message: `"${name}" no tiene producto del catálogo` });
		if (!item.price_id && !(Number(item.final_price) > 0)) errors.push({ field: field('final_price'), message: `"${name}" no tiene precio` });
		if (!item.start_date) errors.push({ field: field('start_date'), message: `"${name}" no tiene fecha de inicio` });
		if (!item.term_months && !item.end_date) errors.push({ field: field('term_months'), message: `"${name}" no tiene plazo ni fecha de fin` });
		if (!item.billing_frequency) errors.push({ field: field('billing_frequency'), message: `"${name}" no tiene frecuencia de facturación` });
		if (!item.billing_method) errors.push({ field: field('billing_method'), message: `"${name}" no tiene método de facturación` });
	});

	return errors;
}

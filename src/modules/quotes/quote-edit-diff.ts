/**
 * Diff campo a campo de una edición de cotización (`PUT /quotes/:id`, Domi 02-10): lo guarda el evento `UPDATED` en
 * `metadata.changes` (encabezado) y `metadata.item_changes` (por ítem: agregado, quitado o cambiado). Toda edición lo deja, en
 * cualquier etapa; en `signed`/`lost` además `metadata.edited_after_signature = true`. Puro: sin base ni Nest.
 */

export interface QuoteFieldChange {
	field: string;
	label: string;
	before: string | number | boolean | null;
	after: string | number | boolean | null;
	/** Nombre legible cuando el valor es un id (cliente, contacto, vendedor, producto). */
	before_label?: string | null;
	after_label?: string | null;
}

export interface QuoteItemChange {
	action: 'added' | 'removed' | 'changed';
	item_id: string | null;
	product_name: string | null;
	changes: QuoteFieldChange[];
}

export type DiffValue = string | number | boolean | null | undefined;

/** Snapshot comparable de un ítem (antes: fila guardada; después: ítem resuelto del DTO). */
export interface QuoteItemSnapshot {
	product_id: string | null;
	product_name: string | null;
	quantity: number | null;
	unit_price: number | null;
	annual_unit_price: number | null;
	price_entry_mode: string | null;
	discount_value: number | null;
	final_price: number | null;
	start_date: string | null;
	end_date: string | null;
	term_months: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
	is_recurring: boolean | null;
	/** Id del precio (Pricing v2) cuando cambia el modelo de precio; null = precio fijo. */
	price_id?: string | null;
}

export const QUOTE_HEADER_LABELS: Record<string, string> = {
	client_id: 'Cliente',
	client_contact_id: 'Contacto',
	seller_id: 'Vendedor',
	quote_type: 'Tipo de negocio',
	quote_date: 'Fecha de cotización',
	valid_until: 'Válida hasta',
	booking_date: 'Fecha de cierre (booking)',
	currency: 'Moneda',
	total_amount: 'Total',
	payment_terms: 'Condición de pago',
	notes: 'Notas',
	requires_multicompany: 'Requiere multicompañía',
	requires_multicurrency: 'Requiere multimoneda',
	requires_references_for_billing: 'Requiere referencias para facturar',
	requires_contract_document: 'Requiere documento de contrato',
};

export const QUOTE_ITEM_LABELS: Record<keyof QuoteItemSnapshot, string> = {
	product_id: 'Producto',
	product_name: 'Nombre del producto',
	quantity: 'Cantidad',
	unit_price: 'Precio',
	annual_unit_price: 'Precio anual',
	price_entry_mode: 'Modo de precio',
	discount_value: 'Descuento %',
	final_price: 'Total línea',
	start_date: 'Inicio',
	end_date: 'Fin',
	term_months: 'Plazo (meses)',
	billing_frequency: 'Frecuencia',
	billing_method: 'Facturación',
	is_recurring: 'Recurrente',
	price_id: 'Modelo de precio',
};

/** Campos del ítem que se comparan (en orden de lectura). `product_name` va como etiqueta de `product_id`. */
const ITEM_FIELDS: ReadonlyArray<keyof QuoteItemSnapshot> = [
	'product_id',
	'quantity',
	'unit_price',
	'annual_unit_price',
	'discount_value',
	'start_date',
	'end_date',
	'term_months',
	'billing_frequency',
	'billing_method',
	'is_recurring',
	'final_price',
	'price_id',
];

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Normaliza para comparar y guardar: números redondeados, fechas `YYYY-MM-DD`, vacío → null. */
export function normalizeDiffValue(value: DiffValue): string | number | boolean | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'number') return Number.isFinite(value) ? round6(value) : null;
	if (typeof value === 'boolean') return value;

	return String(value);
}

const numeric = (value: DiffValue) => {
	const normalized = normalizeDiffValue(value);

	if (normalized === null || typeof normalized === 'boolean') return normalized;
	const parsed = Number(normalized);

	return Number.isFinite(parsed) ? round6(parsed) : normalized;
};

const same = (a: DiffValue, b: DiffValue) => {
	const left = normalizeDiffValue(a);
	const right = normalizeDiffValue(b);

	if (left === right) return true;
	if (left === null || right === null) return false;

	return numeric(left) === numeric(right);
};

const numericField = (field: string) => field === 'total_amount';

/** Un cambio de encabezado por campo distinto. `labels` da el nombre legible (antes/después) de los campos que son ids. */
export function headerChanges(
	before: Record<string, DiffValue>,
	after: Record<string, DiffValue>,
	labels: Record<string, { before?: string | null; after?: string | null }> = {}
): QuoteFieldChange[] {
	return Object.keys(QUOTE_HEADER_LABELS)
		.filter((field) => field in after && !same(before[field], after[field]))
		.map((field) => ({
			field,
			label: QUOTE_HEADER_LABELS[field],
			before: numericField(field) ? numeric(before[field]) : normalizeDiffValue(before[field]),
			after: numericField(field) ? numeric(after[field]) : normalizeDiffValue(after[field]),
			...(labels[field] ? { before_label: labels[field].before ?? null, after_label: labels[field].after ?? null } : {}),
		}));
}

const NUMERIC_ITEM_FIELDS = new Set<keyof QuoteItemSnapshot>([
	'quantity',
	'unit_price',
	'annual_unit_price',
	'discount_value',
	'final_price',
	'term_months',
]);

function itemFieldChange(field: keyof QuoteItemSnapshot, before: QuoteItemSnapshot | null, after: QuoteItemSnapshot | null): QuoteFieldChange {
	const read = (snapshot: QuoteItemSnapshot | null) => {
		const value = snapshot ? (snapshot[field] as DiffValue) : null;

		return NUMERIC_ITEM_FIELDS.has(field) ? numeric(value) : normalizeDiffValue(value);
	};

	return {
		field,
		label: QUOTE_ITEM_LABELS[field],
		before: read(before),
		after: read(after),
		...(field === 'product_id' ? { before_label: before?.product_name ?? null, after_label: after?.product_name ?? null } : {}),
	};
}

/** Campos que se muestran al agregar/quitar un ítem (el resto queda implícito). */
const SNAPSHOT_FIELDS: ReadonlyArray<keyof QuoteItemSnapshot> = [
	'product_id',
	'quantity',
	'unit_price',
	'discount_value',
	'start_date',
	'term_months',
	'final_price',
];

/**
 * Cambios por ítem: `before` por id guardado, `after` con el id del ítem (null si es nuevo). Ítems con id en ambos lados → `changed`
 * solo si algún campo difiere; sin id o nuevo → `added`; ausentes → `removed`. En modo anual se compara `annual_unit_price` y no `unit_price`.
 */
export function itemChanges(
	before: ReadonlyMap<string, QuoteItemSnapshot>,
	after: ReadonlyArray<{ id: string | null; snapshot: QuoteItemSnapshot }>
): QuoteItemChange[] {
	const result: QuoteItemChange[] = [];
	const kept = new Set<string>();

	for (const { id, snapshot } of after) {
		const previous = id ? before.get(id) : undefined;

		if (!id || !previous) {
			result.push({
				action: 'added',
				item_id: id,
				product_name: snapshot.product_name,
				changes: SNAPSHOT_FIELDS.map((field) => itemFieldChange(field, null, snapshot)).filter((change) => change.after !== null),
			});
			continue;
		}
		kept.add(id);
		const annual = snapshot.price_entry_mode === 'annual' || previous.price_entry_mode === 'annual';
		const changes = ITEM_FIELDS.filter((field) => (annual ? field !== 'unit_price' : field !== 'annual_unit_price'))
			.filter((field) => field !== 'price_id' || 'price_id' in snapshot)
			.filter((field) => !same(previous[field] as DiffValue, snapshot[field] as DiffValue))
			.map((field) => itemFieldChange(field, previous, snapshot));

		if (changes.length) result.push({ action: 'changed', item_id: id, product_name: snapshot.product_name ?? previous.product_name, changes });
	}
	for (const [id, snapshot] of before) {
		if (kept.has(id)) continue;
		result.push({
			action: 'removed',
			item_id: id,
			product_name: snapshot.product_name,
			changes: SNAPSHOT_FIELDS.map((field) => itemFieldChange(field, snapshot, null)).filter((change) => change.before !== null),
		});
	}

	return result;
}

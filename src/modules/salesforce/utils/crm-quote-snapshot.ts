/**
 * Cotizaciones del CRM protegidas (regla de Domi, 03-10). Puro: sin base ni Nest.
 *
 * - **Snapshot**: lo que llegó del CRM la última vez que la oportunidad se importó a Sapira (encabezado mapeado + ítems resueltos). Se
 *   guarda en `salesforce_opportunities_stg.last_imported_snapshot` en la misma transacción que crea o actualiza la cotización.
 * - **Cambio real** = lo que llega ahora del CRM es distinto del snapshot. No se compara contra la cotización actual: lo que una persona
 *   editó en Sapira se respeta mientras el CRM no cambie.
 * - Las cotizaciones con contrato (o en etapa `contract_created`) nunca se actualizan.
 */

export type CrmSnapshotValue = string | number | boolean | null;

export interface CrmQuoteSnapshotItem {
	salesforce_line_item_id: string;
	product_id: string | null;
	product_name: string | null;
	quantity: number | null;
	unit_price: number | null;
	discount_value: number | null;
	final_price: number | null;
	start_date: string | null;
	end_date: string | null;
	term_months: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
	is_recurring: boolean | null;
	currency: string | null;
}

export interface CrmQuoteSnapshot {
	version: 1;
	/** Encabezado mapeado (mapeos de campos de la oportunidad) + dueño y cuenta del CRM. Sin `notes`: la importación no las actualiza. */
	header: Record<string, CrmSnapshotValue>;
	items: CrmQuoteSnapshotItem[];
	/**
	 * `true`: no hubo una importación con snapshot (cotización anterior a la regla); se tomó como base lo que llegó del CRM la primera vez
	 * que se volvió a traer. Desde ahí se compara igual que un snapshot de importación.
	 */
	baseline?: boolean;
}

/** Cambio de un campo del CRM entre la última importación (`before`) y lo que llega ahora (`after`). */
export interface CrmSnapshotFieldChange {
	scope: 'quote' | 'quote_item';
	/** `quote.<campo>` o `quote_item.<id del ítem en el CRM>.<campo>`. */
	field: string;
	label: string;
	/** Ítem afectado (solo `quote_item`). */
	item_key: string | null;
	item_label: string | null;
	/** `added`/`removed`: el ítem llegó o dejó de llegar desde el CRM. */
	item_action: 'added' | 'removed' | 'changed' | null;
	before: CrmSnapshotValue;
	after: CrmSnapshotValue;
}

/** Campos del encabezado que no se comparan (vínculo técnico o que la importación no aplica a una cotización existente). */
export const CRM_SNAPSHOT_IGNORED_HEADER_FIELDS = ['notes', 'salesforce_opportunity_id'];

export const CRM_SNAPSHOT_HEADER_LABELS: Record<string, string> = {
	quote_number: 'Número de cotización',
	quote_type: 'Tipo de negocio',
	quote_date: 'Fecha de cotización',
	valid_until: 'Válida hasta',
	booking_date: 'Fecha de cierre (booking)',
	currency: 'Moneda',
	total_amount: 'Total',
	payment_terms: 'Condición de pago',
	requires_multicompany: 'Requiere multicompañía',
	requires_multicurrency: 'Requiere multimoneda',
	requires_references_for_billing: 'Requiere referencias para facturar',
	requires_contract_document: 'Requiere documento de contrato',
	crm_owner: 'Dueño en el CRM (vendedor)',
	crm_account_id: 'Cuenta del CRM (cliente)',
};

export const CRM_SNAPSHOT_ITEM_LABELS: Record<Exclude<keyof CrmQuoteSnapshotItem, 'salesforce_line_item_id'>, string> = {
	product_id: 'Producto',
	product_name: 'Nombre del producto',
	quantity: 'Cantidad',
	unit_price: 'Precio',
	discount_value: 'Descuento %',
	final_price: 'Total línea',
	start_date: 'Inicio',
	end_date: 'Fin',
	term_months: 'Plazo (meses)',
	billing_frequency: 'Frecuencia',
	billing_method: 'Facturación',
	is_recurring: 'Recurrente',
	currency: 'Moneda',
};

const ITEM_FIELDS = Object.keys(CRM_SNAPSHOT_ITEM_LABELS) as Array<keyof typeof CRM_SNAPSHOT_ITEM_LABELS>;
/** Campos que se muestran al llegar o dejar de llegar un ítem. */
const ITEM_SUMMARY_FIELDS: Array<keyof typeof CRM_SNAPSHOT_ITEM_LABELS> = ['product_id', 'quantity', 'unit_price', 'start_date', 'final_price'];

const pad = (value: number) => String(value).padStart(2, '0');
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Valor comparable y serializable: fechas `YYYY-MM-DD` (calendario local, como `parseSalesforceDate`), números redondeados, vacío → null. */
export function snapshotValue(value: unknown): CrmSnapshotValue {
	if (value === undefined || value === null || value === '') return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	if (typeof value === 'number') return Number.isFinite(value) ? round6(value) : null;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'object') return JSON.stringify(value);

	return String(value);
}

const sameValue = (a: CrmSnapshotValue, b: CrmSnapshotValue) => {
	if (a === b) return true;
	if (a === null || b === null) return false;
	const left = Number(a);
	const right = Number(b);

	return typeof a !== 'boolean' && typeof b !== 'boolean' && Number.isFinite(left) && Number.isFinite(right) && round6(left) === round6(right);
};

/**
 * Snapshot de lo que llega del CRM. `header` = registro mapeado de la oportunidad; `owner`/`accountId` = dueño y cuenta (definen vendedor
 * y cliente); `items` = ítems resueltos (`resolveLineItemPreview`).
 */
export function buildCrmQuoteSnapshot(input: {
	header: Record<string, unknown>;
	owner?: string | null;
	accountId?: string | null;
	items: Array<Record<string, unknown> & { salesforce_line_item_id?: unknown }>;
}): CrmQuoteSnapshot {
	const header: Record<string, CrmSnapshotValue> = {};

	for (const key of Object.keys(input.header).sort()) {
		if (CRM_SNAPSHOT_IGNORED_HEADER_FIELDS.includes(key)) continue;
		header[key] = snapshotValue(input.header[key]);
	}
	header.crm_owner = snapshotValue(input.owner ?? null);
	header.crm_account_id = snapshotValue(input.accountId ?? null);

	const items = input.items
		.map((item) => {
			const snapshot = { salesforce_line_item_id: String(item.salesforce_line_item_id ?? '') } as CrmQuoteSnapshotItem;

			for (const field of ITEM_FIELDS) (snapshot as unknown as Record<string, CrmSnapshotValue>)[field] = snapshotValue(item[field]);

			return snapshot;
		})
		.sort((a, b) => a.salesforce_line_item_id.localeCompare(b.salesforce_line_item_id));

	return { version: 1, header, items };
}

/** Forma de columna jsonb (`last_imported_snapshot`) de un snapshot. */
export function storedCrmQuoteSnapshot(snapshot: CrmQuoteSnapshot): Record<string, any> {
	return snapshot as unknown as Record<string, any>;
}

/** Lee un snapshot guardado (jsonb); `null` si no hay o no tiene la forma esperada. */
export function readCrmQuoteSnapshot(value: unknown): CrmQuoteSnapshot | null {
	if (!value || typeof value !== 'object') return null;
	const snapshot = value as Partial<CrmQuoteSnapshot>;

	if (!snapshot.header || typeof snapshot.header !== 'object' || !Array.isArray(snapshot.items)) return null;

	return snapshot as CrmQuoteSnapshot;
}

const headerLabel = (field: string) => CRM_SNAPSHOT_HEADER_LABELS[field] ?? field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const itemLabel = (item: CrmQuoteSnapshotItem) => item.product_name ?? item.salesforce_line_item_id;

/** Diferencias campo a campo entre lo que llegó en la última importación (`before`) y lo que llega ahora (`after`). */
export function crmSnapshotChanges(before: CrmQuoteSnapshot, after: CrmQuoteSnapshot): CrmSnapshotFieldChange[] {
	const changes: CrmSnapshotFieldChange[] = [];
	const headerKeys = [...new Set([...Object.keys(before.header), ...Object.keys(after.header)])].filter(
		(key) => !CRM_SNAPSHOT_IGNORED_HEADER_FIELDS.includes(key)
	);

	for (const field of headerKeys) {
		const previous = before.header[field] ?? null;
		const next = after.header[field] ?? null;

		if (sameValue(previous, next)) continue;
		changes.push({
			scope: 'quote',
			field: `quote.${field}`,
			label: headerLabel(field),
			item_key: null,
			item_label: null,
			item_action: null,
			before: previous,
			after: next,
		});
	}

	const beforeItems = new Map(before.items.map((item) => [item.salesforce_line_item_id, item]));
	const afterItems = new Map(after.items.map((item) => [item.salesforce_line_item_id, item]));
	const itemChange = (
		key: string,
		label: string,
		action: CrmSnapshotFieldChange['item_action'],
		field: keyof typeof CRM_SNAPSHOT_ITEM_LABELS,
		previous: CrmSnapshotValue,
		next: CrmSnapshotValue
	): CrmSnapshotFieldChange => ({
		scope: 'quote_item',
		field: `quote_item.${key}.${field}`,
		label: CRM_SNAPSHOT_ITEM_LABELS[field],
		item_key: key,
		item_label: label,
		item_action: action,
		before: previous,
		after: next,
	});

	for (const [key, next] of afterItems) {
		const previous = beforeItems.get(key);

		if (!previous) {
			for (const field of ITEM_SUMMARY_FIELDS) {
				if (next[field] !== null) changes.push(itemChange(key, itemLabel(next), 'added', field, null, next[field]));
			}
			continue;
		}
		for (const field of ITEM_FIELDS) {
			if (!sameValue(previous[field] ?? null, next[field] ?? null)) {
				changes.push(itemChange(key, itemLabel(next), 'changed', field, previous[field] ?? null, next[field] ?? null));
			}
		}
	}
	for (const [key, previous] of beforeItems) {
		if (afterItems.has(key)) continue;
		for (const field of ITEM_SUMMARY_FIELDS) {
			if (previous[field] !== null) changes.push(itemChange(key, itemLabel(previous), 'removed', field, previous[field], null));
		}
	}

	return changes;
}

/** El CRM cambió desde la última importación. */
export function crmSnapshotChanged(before: CrmQuoteSnapshot, after: CrmQuoteSnapshot): boolean {
	return crmSnapshotChanges(before, after).length > 0;
}

// ── Protección ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CrmQuoteProtection = 'contract' | 'contract_created' | null;

export const CRM_QUOTE_PROTECTION_MESSAGES: Record<Exclude<CrmQuoteProtection, null>, string> = {
	contract: 'La cotización ya tiene contrato: no se actualiza',
	contract_created: 'Procesada previamente: no se actualiza',
};

/** Cotización protegida: con contrato vigente (directo o por sus ítems) o en una etapa de tipo `contract_created`. */
export function crmQuoteProtection(row: { has_contract?: unknown; stage_kind?: unknown } | null | undefined): CrmQuoteProtection {
	if (!row) return null;
	if (row.has_contract === true || row.has_contract === 't') return 'contract';
	if (row.stage_kind === 'contract_created') return 'contract_created';

	return null;
}

/** SQL de la protección de una cotización (`$1` = id de la cotización, `$2` = holding). Mismo criterio que `crmQuoteProtection`. */
export const CRM_QUOTE_PROTECTION_SQL = `SELECT q.quote_stage_id::text AS stage_id, qs.kind AS stage_kind,
	(EXISTS (SELECT 1 FROM contracts c WHERE c.quote_id = q.id AND c.deleted_at IS NULL)
		OR EXISTS (SELECT 1 FROM quote_items qi JOIN contract_items ci ON ci.quote_item_id = qi.id
			JOIN contracts c ON c.id = ci.contract_id AND c.deleted_at IS NULL WHERE qi.quote_id = q.id)) AS has_contract
	FROM quotes q LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id WHERE q.id = $1 AND q.holding_id = $2`;

// ── Estado de clasificación ────────────────────────────────────────────────────────────────────────────────────────────────

export const CRM_QUOTE_NOTES = {
	unchanged: 'Sin cambios en el CRM desde la última importación',
	baseline: 'Sin cambios: no hay una importación anterior con qué comparar; desde ahora se compara con lo que llegó del CRM',
	changed: 'Cambió en el CRM desde la última importación: revisa las diferencias y confirma para actualizar la cotización',
	needsConfirmation: 'Cambió en el CRM: la cotización se actualiza solo si confirmas la importación de este registro',
	applied: 'Cotización actualizada con los cambios del CRM',
} as const;

export interface CrmQuoteClassification {
	processing_status: 'processed' | 'update';
	integration_notes: string;
	/** Guardar este snapshot como base (cotización sin snapshot previo). */
	baseline: CrmQuoteSnapshot | null;
}

/** Clasifica una oportunidad cuya cotización ya existe en Sapira (puro). */
export function classifyExistingCrmQuote(input: {
	protection: CrmQuoteProtection;
	stored: CrmQuoteSnapshot | null;
	incoming: CrmQuoteSnapshot;
}): CrmQuoteClassification {
	if (input.protection) {
		return { processing_status: 'processed', integration_notes: CRM_QUOTE_PROTECTION_MESSAGES[input.protection], baseline: null };
	}
	if (!input.stored) {
		return { processing_status: 'processed', integration_notes: CRM_QUOTE_NOTES.baseline, baseline: { ...input.incoming, baseline: true } };
	}
	if (crmSnapshotChanged(input.stored, input.incoming)) {
		return { processing_status: 'update', integration_notes: CRM_QUOTE_NOTES.changed, baseline: null };
	}

	return { processing_status: 'processed', integration_notes: CRM_QUOTE_NOTES.unchanged, baseline: null };
}

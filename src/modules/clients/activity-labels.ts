/**
 * Textos de la Actividad del Cliente 360 en español de negocio (pedido de Domi 03-10): **un solo diccionario** para nombres de campo,
 * estados, medios de pago, canales de cobranza y tipos de evento, más la limpieza de textos guardados con términos técnicos. Ningún nombre
 * interno (`status`, `snake_case`, códigos en inglés) llega a la interfaz. Puro: sin Nest ni base.
 */

type Kind = 'money' | 'date' | 'bool' | 'ref' | 'longtext' | 'text' | 'number' | 'currency' | 'enum';

interface FieldInfo {
	label: string;
	kind: Kind;
}

/** Campos del contrato (`contract_change_log.fields_changed` y `before_values`/`after_values`). */
export const CONTRACT_FIELDS: Record<string, FieldInfo> = {
	status: { label: 'Estado', kind: 'enum' },
	total_value: { label: 'Valor total', kind: 'money' },
	total_value_system_currency: { label: 'Valor total en moneda del sistema', kind: 'money' },
	contract_number: { label: 'Número de contrato', kind: 'text' },
	contract_start_date: { label: 'Fecha de inicio', kind: 'date' },
	contract_end_date: { label: 'Fecha de término', kind: 'date' },
	booking_date: { label: 'Fecha de firma', kind: 'date' },
	churn_date: { label: 'Fecha de baja', kind: 'date' },
	churn_reason: { label: 'Motivo de baja', kind: 'text' },
	churn_reason_id: { label: 'Motivo de baja', kind: 'ref' },
	term: { label: 'Plazo (meses)', kind: 'number' },
	type: { label: 'Tipo', kind: 'text' },
	notes: { label: 'Notas', kind: 'longtext' },
	invoice_terms_and_conditions: { label: 'Términos y condiciones de la factura', kind: 'longtext' },
	contract_currency: { label: 'Moneda del contrato', kind: 'currency' },
	invoice_currency: { label: 'Moneda de facturación', kind: 'currency' },
	system_currency: { label: 'Moneda del sistema', kind: 'currency' },
	company_currency: { label: 'Moneda de la compañía', kind: 'currency' },
	fx_rate_to_system: { label: 'Tipo de cambio a moneda del sistema', kind: 'number' },
	fx_invoice_policy: { label: 'Tipo de cambio de la factura', kind: 'enum' },
	fx_company_policy: { label: 'Tipo de cambio de la compañía', kind: 'enum' },
	quote_id: { label: 'Cotización asociada', kind: 'ref' },
	client_id: { label: 'Cliente', kind: 'ref' },
	client_entity_id: { label: 'Razón social', kind: 'ref' },
	company_id: { label: 'Compañía', kind: 'ref' },
	legal_client_name: { label: 'Razón social', kind: 'text' },
	client_name_commercial: { label: 'Nombre comercial del cliente', kind: 'text' },
	legal_representative_name: { label: 'Representante legal', kind: 'text' },
	legal_representative_id: { label: 'Representante legal', kind: 'ref' },
	auto_invoice: { label: 'Facturación automática', kind: 'bool' },
	auto_send_to_odoo: { label: 'Envío automático al ERP', kind: 'bool' },
	group_invoices_by_period: { label: 'Agrupar facturas por período', kind: 'bool' },
	requires_contract_document: { label: 'Requiere documento del contrato', kind: 'bool' },
	requires_multicompany_billing: { label: 'Facturación multicompañía', kind: 'bool' },
	requires_multicurrency_billing: { label: 'Facturación multimoneda', kind: 'bool' },
	requires_references_for_billing: { label: 'Requiere referencias para facturar', kind: 'bool' },
	custom_fields: { label: 'Campos personalizados', kind: 'longtext' },
	renewed_from_contract_id: { label: 'Contrato renovado desde', kind: 'ref' },
	renewed_to_contract_id: { label: 'Contrato renovado hacia', kind: 'ref' },
	salesforce_opportunity_id: { label: 'Oportunidad del CRM', kind: 'ref' },
	legacy_cutoff_date: { label: 'Fecha de corte del histórico', kind: 'date' },
};

/** Valores de estados y políticas que pueden venir en inglés o como código. */
const ENUM_VALUES: Record<string, string> = {
	active: 'Activo',
	draft: 'Borrador',
	cancelled: 'Cancelado',
	canceled: 'Cancelado',
	expired: 'Vencido',
	pending_renewal: 'Por renovar',
	in_review: 'En revisión',
	spot: 'Al emitir',
	fixed: 'Fija',
	net_exact: 'Neto exacto',
	monthly_avg: 'Promedio mensual',
	daily: 'Diaria',
};

/** Medios de pago (`invoice_payments.method`). */
export const PAYMENT_METHODS: Record<string, string> = {
	transfer: 'Transferencia',
	bank_transfer: 'Transferencia',
	wire: 'Transferencia',
	cash: 'Efectivo',
	check: 'Cheque',
	cheque: 'Cheque',
	card: 'Tarjeta',
	credit_card: 'Tarjeta de crédito',
	debit_card: 'Tarjeta de débito',
	deposit: 'Depósito',
	compensation: 'Compensación',
	offset: 'Compensación',
	credit_note: 'Nota de crédito',
	stripe: 'Pago en línea',
	other: 'Otro',
};

/** Canales de cobranza (`invoice_collection_logs.channel`). */
export const COLLECTION_CHANNELS: Record<string, string> = {
	email: 'Correo',
	mail: 'Correo',
	phone: 'Teléfono',
	call: 'Llamada',
	whatsapp: 'WhatsApp',
	sms: 'SMS',
	letter: 'Carta',
	manual: 'Manual',
	visit: 'Visita',
	other: 'Otro',
};

/** Tipos de evento del contrato (`contract_lifecycle_events.event_type`) cuando el evento no trae título. */
export const CONTRACT_EVENT_TYPES: Record<string, string> = {
	CREATED: 'Contrato creado',
	ACTIVATION: 'Contrato activado',
	RENEWAL: 'Renovación aplicada',
	RENEWAL_PROPOSED: 'Propuesta de renovación',
	NON_RENEWAL: 'No renovación',
	CHURN: 'Baja del contrato',
	DOWNSELL: 'Reducción parcial',
	DOWNSELL_APPLIED: 'Reducción aplicada',
	UPSELL_APPLIED: 'Ampliación aplicada',
	CROSS_SELL: 'Venta cruzada aplicada',
	CROSS_SELL_APPLIED: 'Venta cruzada aplicada',
	INVOICE_CANCELLED: 'Factura anulada',
	INVOICE_CREDIT_NOTE: 'Nota de crédito',
	INVOICE_EMITTED_MANUALLY: 'Factura emitida manualmente',
	INVOICE_UNIFICATION: 'Facturas unificadas',
	INVOICE_UNCONSOLIDATION: 'Facturas separadas',
	INVOICE_DESCRIPTIONS_UPDATED: 'Descripciones de la factura actualizadas',
	INVOICE_REFERENCES_UPDATED: 'Referencias de la factura actualizadas',
	CONTRACT_RENUMBERED: 'Número de contrato corregido',
	CONTRACT_DESCRIPTION_TEMPLATE_CHANGED: 'Plantilla de descripción actualizada',
	SCHEDULED_CHANGE_CREATED: 'Ajuste pactado',
};

/** Términos técnicos o en inglés que aparecen en textos guardados (títulos y resúmenes de eventos). */
const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\bNC discount\b/gi, 'NC por descuento'],
	[/\bNC cancellation\b/gi, 'NC de anulación'],
	[/\bpor reschedule\b/gi, 'por reprogramación'],
	[/\breschedule\b/gi, 'reprogramación'],
	[/\bcancellation\b/gi, 'anulación'],
	[/\bdiscount\b/gi, 'descuento'],
	[/\bItems afectados\b/g, 'Ítems afectados'],
	[/\bitems\b/g, 'ítems'],
	[/\bUPSELL\b/g, 'Upsell'],
	[/\bDOWNSELL\b/g, 'Downsell'],
	[/\bCROSS[-_]SELL\b/g, 'Cross-sell'],
	[/\bpending_renewal\b/g, 'por renovar'],
	[/\bAplicada\b/g, 'aplicada'],
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** `2026-10-31` → `31-10-2026`. */
export function formatDate(value: unknown): string {
	const text = String(value ?? '');

	if (!ISO_DATE.test(text)) return text;
	const [year, month, day] = text.slice(0, 10).split('-');

	return `${day}-${month}-${year}`;
}

/** Monto con separadores chilenos y hasta 2 decimales (`USD 1.200,5`). */
export function formatAmount(value: unknown, currency?: string | null): string {
	const number = Number(value);

	if (!Number.isFinite(number)) return String(value ?? '');
	const text = number.toLocaleString('es-CL', { maximumFractionDigits: 2 });

	return currency ? `${currency} ${text}` : text;
}

const stripHtml = (value: string) =>
	value
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const isEmpty = (value: unknown) => value === null || value === undefined || value === '';

/** Valor legible de un campo del contrato. */
export function formatFieldValue(field: string, value: unknown, currency?: string | null): string {
	if (isEmpty(value)) return '—';
	const info = CONTRACT_FIELDS[field];

	switch (info?.kind) {
		case 'money':
			return formatAmount(value, currency);
		case 'date':
			return formatDate(value);
		case 'bool':
			return value === true || value === 'true' ? 'Sí' : 'No';
		case 'number':
			return formatAmount(value);
		case 'enum':
			return ENUM_VALUES[String(value).toLowerCase()] ?? humanizeText(String(value));
		case 'currency':
			return String(value).toUpperCase();
		default:
			return humanizeText(stripHtml(String(value)));
	}
}

/**
 * Detalle de un cambio del contrato (`contract_change_log`): "Estado: Borrador → Activo · Valor total: USD 100 → USD 120". Campos de
 * referencia y textos largos dicen "actualizado/a" sin mostrar ids ni HTML. Campos desconocidos se agrupan como "otros datos". Sin cambios
 * visibles devuelve null.
 */
export function describeContractChange(input: {
	change_type?: string | null;
	fields?: unknown;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	currency?: string | null;
	reason?: string | null;
}): string | null {
	const type = String(input.change_type ?? 'UPDATE').toUpperCase();
	const reason = input.reason?.trim() ? `Motivo: ${humanizeText(input.reason.trim())}` : null;

	if (type !== 'UPDATE') return reason;
	const fields = Array.isArray(input.fields) ? input.fields.map(String) : Object.keys(input.after ?? {});
	const parts: string[] = [];
	let others = 0;

	for (const field of [...new Set(fields)]) {
		const info = CONTRACT_FIELDS[field];
		const before = input.before?.[field];
		const after = input.after?.[field];

		if (!info) {
			others += 1;
			continue;
		}
		if (info.kind === 'ref' || info.kind === 'longtext') {
			if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null) || (before === undefined && after === undefined))
				parts.push(`${info.label}: actualizado`);
			continue;
		}
		if (before === undefined && after === undefined) {
			parts.push(`${info.label}: actualizado`);
			continue;
		}
		const from = formatFieldValue(field, before, input.currency);
		const to = formatFieldValue(field, after, input.currency);

		if (from !== to) parts.push(`${info.label}: ${from} → ${to}`);
	}
	if (others) parts.push(others === 1 ? 'Otro dato actualizado' : `${others} datos más actualizados`);
	if (reason) parts.push(reason);

	return parts.length ? parts.join(' · ') : null;
}

/** Título del registro de cambios según su tipo. */
export function contractChangeTitle(changeType: string | null | undefined, contractNumber: string | null | undefined): string {
	const number = contractNumber ? ` · ${contractNumber}` : '';

	switch (String(changeType ?? '').toUpperCase()) {
		case 'CREATE':
			return `Contrato registrado${number}`;
		case 'DELETE':
			return `Contrato eliminado${number}`;
		default:
			return `Contrato modificado${number}`;
	}
}

/** Título de un evento del contrato: el guardado (limpio) o el del tipo; nunca el código. */
export function contractEventTitle(title: string | null | undefined, eventType: string | null | undefined): string {
	if (title?.trim()) return humanizeText(title.trim());
	const key = String(eventType ?? '').toUpperCase();

	return CONTRACT_EVENT_TYPES[key] ?? 'Evento del contrato';
}

export const paymentMethodLabel = (value: string | null | undefined) =>
	value ? (PAYMENT_METHODS[value.trim().toLowerCase()] ?? humanizeText(value)) : null;

export const collectionChannelLabel = (value: string | null | undefined) =>
	value ? (COLLECTION_CHANNELS[value.trim().toLowerCase()] ?? humanizeText(value)) : null;

/**
 * Limpia un texto guardado: términos en inglés de la lista, números con decimales de más (4 o más decimales: `9999.9999999999999996` → `10.000`; `2.040` queda igual, puede ser un miles) y claves
 * `snake_case` sueltas (pasan a palabras).
 */
export function humanizeText(value: string): string {
	let text = String(value ?? '');

	for (const [pattern, replacement] of TEXT_REPLACEMENTS) text = text.replace(pattern, replacement);
	text = text.replace(/-?\d+\.\d{4,}/g, (match) => formatAmount(Number(match)));
	text = text.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (match) => {
		const field = CONTRACT_FIELDS[match];

		return field ? field.label.toLowerCase() : (ENUM_VALUES[match] ?? match.replace(/_/g, ' '));
	});

	return text;
}

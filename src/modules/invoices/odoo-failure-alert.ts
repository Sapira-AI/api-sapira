/**
 * Alerta `invoice_odoo_failure` **agrupada por causa** (Domi 28-10, `docs/cambios/errores-emision-erp-28-10.md` §B). Puro: arma la clave de
 * deduplicación, la lista de facturas y el contenido (título, cuerpo, acción, metadata) que el scheduler manda a `createOrUpdate`, y que el
 * cierre automático usa para sacar una factura del grupo. Una alerta por compañía emisora, día de negocio, etapa y causa traducida: las 29
 * facturas de Simplit sin folios CAF son un solo aviso con sus 29 facturas dentro; una sola factura conserva la forma de siempre (título
 * con folio y cliente, acción "Ver contrato", `resource_id` = la factura).
 */
import { createHash } from 'crypto';

import { cleanErpMessage, erpErrorSentence, type ErpErrorTranslation } from './erp-error-translation';

export const ODOO_FAILURE_STAGES = ['create_draft', 'post_invoice', 'emit_electronic_invoice', 'send_invoice_to_customer', 'product_mapping'] as const;
export type OdooFailureStage = (typeof ODOO_FAILURE_STAGES)[number];

/** Factura dentro del aviso (`metadata.invoices[]`). Solo lo que el front muestra o enlaza; nada técnico. */
export interface OdooFailureInvoice {
	id: string;
	invoice_number: string | null;
	client_name: string | null;
	contract_id: string | null;
	odoo_invoice_id: number | null;
	/** `YYYY-MM-DD`, para nombrar una factura sin folio. */
	issue_date: string | null;
}

/** Tope de facturas guardadas en el aviso (como el cierre de mes); `invoice_count` lleva el total real. */
export const ODOO_FAILURE_MAX_INVOICES = 200;

/**
 * "Qué hacemos nosotros" según dónde falló. Solo antes de crear el borrador hay reintento automático: `pendingInvoicesQuery` exige
 * `sent_to_odoo_at IS NULL`, y un borrador o un documento ya publicado en el ERP no se vuelve a enviar (lo duplicaría).
 */
export const ODOO_FAILURE_WHAT_WE_DO: Record<OdooFailureStage, string> = {
	create_draft: 'La factura sigue Por Emitir: la reintentamos en la próxima corrida automática y cerramos este aviso cuando se envía bien.',
	product_mapping: 'La factura sigue Por Emitir: la reintentamos en la próxima corrida automática y cerramos este aviso cuando se envía bien.',
	post_invoice:
		'No la reintentamos solos: el borrador ya existe en el ERP y un reenvío lo duplicaría. Cuando el borrador se confirme en el ERP, Sapira toma el folio; después archiva este aviso.',
	emit_electronic_invoice:
		'No la reintentamos solos: la factura ya está publicada en el ERP. Cuando se vuelva a timbrar allí, archiva este aviso.',
	send_invoice_to_customer: 'La factura ya está emitida en el ERP; solo falló el correo al cliente. Envíaselo desde el ERP y archiva este aviso.',
};

/** Fecha `YYYY-MM-DD` en la zona del negocio (la misma del envío: `TZ` o America/Santiago). */
export function businessDay(date: Date, timeZone: string): string {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}

const hash8 = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 8);

/**
 * Clave de deduplicación del grupo: compañía emisora + día de negocio + etapa + causa. La causa es la categoría traducida y un hash del
 * mensaje traducido: dos CAF agotados en la misma secuencia comparten aviso; dos razones sociales sin vincular (el mensaje nombra al
 * cliente) no.
 */
export function odooFailureGroupKey(params: {
	companyId: string | null | undefined;
	day: string;
	stage: OdooFailureStage;
	translation: Pick<ErpErrorTranslation, 'category' | 'message'>;
}): string {
	return `invoice-odoo-failure:${params.companyId || 'sin-compania'}:${params.day}:${params.stage}:${params.translation.category}:${hash8(params.translation.message)}`;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Lista de facturas guardada en `metadata.invoices` (tolera metadata vieja o rota: sin lista, `[]`). */
export function failureInvoicesOf(metadata: Record<string, unknown> | null | undefined): OdooFailureInvoice[] {
	const raw = Array.isArray(metadata?.invoices) ? (metadata!.invoices as unknown[]) : [];

	return raw.flatMap((item) => {
		if (!item || typeof item !== 'object') return [];
		const row = item as Record<string, unknown>;
		const id = text(row.id);

		if (!id) return [];

		return [
			{
				id,
				invoice_number: text(row.invoice_number),
				client_name: text(row.client_name),
				contract_id: text(row.contract_id),
				odoo_invoice_id: typeof row.odoo_invoice_id === 'number' ? row.odoo_invoice_id : null,
				issue_date: text(row.issue_date),
			},
		];
	});
}

/** Suma (o reemplaza, por id) una factura a la lista del aviso. */
export function mergeFailureInvoice(existing: OdooFailureInvoice[], incoming: OdooFailureInvoice): OdooFailureInvoice[] {
	const rest = existing.filter((invoice) => invoice.id !== incoming.id);

	return [...rest, incoming].slice(-ODOO_FAILURE_MAX_INVOICES);
}

export interface OdooFailureContentInput {
	invoices: OdooFailureInvoice[];
	/** Total real (puede superar el tope guardado). Por defecto, el largo de la lista. */
	invoiceCount?: number;
	company: { id: string | null; legal_name: string | null; country: string | null };
	stage: OdooFailureStage;
	translation: Pick<ErpErrorTranslation, 'category' | 'message' | 'next_step' | 'action'>;
	errorType: string;
	errorMessage: string;
	schedulerSource: string;
	technicalTitle: string | null;
	technicalMessage: string | null;
	responseData?: unknown;
	errorDetails?: unknown;
}

export interface OdooFailureContent {
	title: string;
	message: string;
	recommendation: string;
	action_type: string | undefined;
	action_payload: Record<string, unknown>;
	resource_type: 'invoice';
	resource_id: string | undefined;
	company_id: string | undefined;
	metadata: Record<string, unknown>;
}

/**
 * Contenido del aviso para N facturas. Con una: la forma de siempre. Con varias: título "No se pudieron enviar N facturas de <compañía>
 * al ERP", sin acción (cada factura se enlaza desde la lista) y `resource_id` vacío; `client_name` solo si todas son del mismo cliente.
 * `metadata.technical_detail` es la frase del ERP limpia (nunca la traza) y `metadata.what_we_do` el texto por etapa.
 */
export function odooFailureContent(input: OdooFailureContentInput): OdooFailureContent {
	const invoices = input.invoices;
	const count = Math.max(input.invoiceCount ?? invoices.length, invoices.length);
	const single = count === 1 && invoices.length === 1 ? invoices[0] : null;
	const clients = [...new Set(invoices.map((invoice) => invoice.client_name).filter((name): name is string => Boolean(name)))];
	const company = input.company.legal_name?.trim() || 'la compañía';
	const title = single
		? `No se pudo enviar la factura ${single.invoice_number || 'sin folio'} de ${single.client_name || 'cliente sin razón social'}`
		: `No se pudieron enviar ${count} facturas de ${company} al ERP`;
	const contractId = single?.contract_id ?? null;

	return {
		title,
		message: erpErrorSentence(input.translation),
		recommendation: input.translation.next_step,
		action_type: contractId ? 'open_contract' : undefined,
		action_payload: contractId ? { contract_id: contractId } : {},
		resource_type: 'invoice',
		resource_id: single?.id,
		company_id: input.company.id ?? undefined,
		metadata: {
			source: 'invoice_scheduler',
			scheduler_source: input.schedulerSource,
			invoice_id: single?.id ?? null,
			invoice_number: single?.invoice_number ?? null,
			odoo_invoice_id: single?.odoo_invoice_id ?? null,
			contract_id: contractId,
			failure_stage: input.stage,
			error_type: input.errorType,
			error_message: input.errorMessage,
			technical_title: input.technicalTitle,
			technical_message: input.technicalMessage,
			technical_detail: cleanErpMessage(input.errorMessage) || null,
			erp_error: {
				category: input.translation.category,
				message: input.translation.message,
				next_step: input.translation.next_step,
				action: input.translation.action,
			},
			what_we_do: ODOO_FAILURE_WHAT_WE_DO[input.stage] ?? null,
			country: input.company.country ?? null,
			client_name: clients.length === 1 ? clients[0] : null,
			company_name: input.company.legal_name ?? null,
			invoices,
			invoice_count: count,
			response_data: input.responseData ?? null,
			error_details: input.errorDetails ?? null,
		},
	};
}

/** Reconstruye la entrada de `odooFailureContent` desde la metadata guardada (para achicar el grupo al enviar bien una factura). */
export function contentInputFromMetadata(metadata: Record<string, unknown>, invoices: OdooFailureInvoice[]): OdooFailureContentInput | null {
	const erp = metadata.erp_error && typeof metadata.erp_error === 'object' ? (metadata.erp_error as Record<string, unknown>) : null;
	const stage = ODOO_FAILURE_STAGES.find((value) => value === metadata.failure_stage);
	const message = text(erp?.message);
	const nextStep = text(erp?.next_step);

	if (!erp || !stage || !message || !nextStep) return null;

	return {
		invoices,
		company: { id: null, legal_name: text(metadata.company_name), country: text(metadata.country) },
		stage,
		translation: {
			category: (text(erp.category) ?? 'unknown') as ErpErrorTranslation['category'],
			message,
			next_step: nextStep,
			action: (text(erp.action) ?? 'none') as ErpErrorTranslation['action'],
		},
		errorType: text(metadata.error_type) ?? 'unknown',
		errorMessage: text(metadata.error_message) ?? '',
		schedulerSource: text(metadata.scheduler_source) ?? 'automatic',
		technicalTitle: text(metadata.technical_title),
		technicalMessage: text(metadata.technical_message),
		responseData: metadata.response_data ?? null,
		errorDetails: metadata.error_details ?? null,
	};
}

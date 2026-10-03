import { type ErpErrorAction, type ErpErrorCategory, translateErpError } from './erp-error-translation';

/**
 * Último intento de envío de una factura al ERP, para el detalle de la factura (vista rápida del 360 y de Facturación): sale del log
 * `invoice_odoo_send_logs` que el scheduler ya escribe en cada intento (manual o automático); sin columnas nuevas.
 */
export interface LastSendAttempt {
	at: string | null;
	ok: boolean;
	/** Etapa del log (`create_draft`, `post_invoice`, `emit_electronic_invoice`, `send_invoice_to_customer`). */
	operation: string | null;
	category: ErpErrorCategory | null;
	message: string;
	next_step: string | null;
	action: ErpErrorAction | null;
	/** Texto técnico del ERP ("detalle técnico" plegable); null si salió bien. */
	raw: string | null;
}

export interface SendLogLike {
	operation?: string | null;
	status?: string | null;
	error_message?: string | null;
	error_type?: string | null;
	odoo_invoice_id?: number | null;
	createdAt?: Date | string | null;
}

const OK_MESSAGES: Record<string, string> = {
	create_draft: 'Enviada al ERP como borrador',
	post_invoice: 'Publicada en el ERP',
	emit_electronic_invoice: 'Emitida electrónicamente desde el ERP',
	send_invoice_to_customer: 'Enviada al cliente desde el ERP',
};

export function lastSendAttemptOf(log: SendLogLike): LastSendAttempt {
	const at = log.createdAt instanceof Date ? log.createdAt.toISOString() : (log.createdAt ?? null);
	const operation = log.operation ?? null;

	if (log.status === 'success') {
		return {
			at,
			ok: true,
			operation,
			category: null,
			message: OK_MESSAGES[operation ?? ''] ?? 'Enviada al ERP',
			next_step: null,
			action: null,
			raw: null,
		};
	}
	const translation = translateErpError(log.error_message, log.error_type);

	return {
		at,
		ok: false,
		operation,
		category: translation.category,
		message: translation.message,
		next_step: translation.next_step,
		action: translation.action,
		raw: translation.raw,
	};
}

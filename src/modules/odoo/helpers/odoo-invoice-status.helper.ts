/**
 * Traducción de los estados de Odoo al `status` de una factura de Sapira.
 *
 * Vive acá, y no dentro del servicio del webhook, porque hay **dos** caminos que la aplican —el
 * aviso en vivo y el backfill— y dos copias de esta regla serían dos verdades distintas sobre lo
 * que significa que una factura esté pagada.
 *
 * `status` está acotado por el CHECK `invoices_status_check` a
 * `Por Emitir | Emitida | Enviada | Pagada | Vencida | Cancelada | Consolidada | Dividida`, así que
 * **no existe un estado intermedio de pago**: una factura parcialmente pagada tiene que caer en uno
 * de esos ocho.
 */

/** Estados de pago de Odoo que Sapira considera cobrados. */
const PAGADA_EN_ODOO = new Set(['paid']);

/**
 * Devuelve el `status` que corresponde, o `null` si Odoo todavía no publicó la factura (en ese caso
 * no hay nada que sincronizar: el folio solo existe a partir de `posted`).
 *
 * **Decisión de Leon (01-10-2026): solo `paid` pasa a `Pagada`.** `partial`, `in_payment` y
 * `reversed` quedan en `Enviada`, o sea abiertas para cuentas por cobrar, y el cron de vencidas las
 * pasa a `Vencida` si corresponde. La versión anterior era
 * `payment_state === 'not_paid' ? 'Enviada' : 'Pagada'`, que mandaba **todo** lo demás —incluidas
 * las parciales, las revertidas y un payload sin `payment_state`— a `Pagada`, e inflaba lo cobrado
 * en el cierre de mes.
 */
export function determinarEstadoSapira(state?: string, paymentState?: string): string | null {
	if (state !== 'posted') return null;

	return paymentState && PAGADA_EN_ODOO.has(paymentState) ? 'Pagada' : 'Enviada';
}

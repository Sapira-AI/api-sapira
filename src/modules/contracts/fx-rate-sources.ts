/**
 * Orígenes de la tasa de una línea de factura (`invoice_items.fx_rate_source`) y qué significa cada uno al emitir (Domi 23-10, caso Carelis:
 * unificada Brightcell CTR-2026-110 rechazada por "Falta el tipo de cambio" con todas sus líneas ya valorizadas).
 *
 * Módulo hoja, sin imports: lo leen el scheduler (envío al ERP), Modificar contrato, la revalorización por par y la vista rápida, para que
 * las listas no vuelvan a divergir. La columna es texto libre heredado; además de estos valores, en producción viven `amendment`,
 * `billing-split` y `spot_unify` (front viejo) y NULL con tasa (datos pegados antes de v2).
 *
 * | Valor                  | Quién lo escribe                                                                    | Con tasa significa                 |
 * |------------------------|-------------------------------------------------------------------------------------|------------------------------------|
 * | `contract`             | activación multimoneda por línea (`contract-activation.service.ts`)                  | tasa por par pactada en el contrato|
 * | `scheduled-generation` | activación de una moneda (`ACTIVATION_FX_RATE_SOURCE`)                              | tasa fija del contrato al generar  |
 * | `contract-change`      | Modificar contrato: moneda/FX a las pendientes y líneas de NC (`CHANGES_FX_RATE_SOURCE`) | tasa de las condiciones del contrato|
 * | `reorganize`           | reorganizar cronograma (`REORGANIZE_FX_RATE_SOURCE`)                                | heredada de la factura de origen   |
 * | `consumption`          | consumos (`CONSUMPTION_FX_RATE_SOURCE`)                                             | la de la factura al valorizar      |
 * | `invoice-edit`         | editor de factura (`EDIT_FX_RATE_SOURCE`)                                           | la que tenía la factura            |
 * | `reissue`              | reemisión tras anular (`REISSUE_FX_RATE_SOURCE`)                                    | copia de la emitida                |
 * | `previous_invoice`     | Datos históricos › facturas previas (`ADOPT_FX_RATE_SOURCE`)                        | la del documento adoptado          |
 * | `partial_by_po`        | facturar por OC, línea de saldo (`PARTIAL_BY_PO_LINE_FX_SOURCE`)                    | la de la factura cubierta          |
 * | `manual`               | Tipo de cambio de la factura › Fija (`planFx`)                                      | fijada por factura                 |
 * | `net_exact`            | Tipo de cambio de la factura › Neto exacto; facturar por OC con neto                | fijada por factura                 |
 * | `manual_unify`         | unificación con tasa manual (histórico, ya no se escribe)                           | fijada por factura                 |
 * | `spot`                 | envío al ERP (valorizada al día) y "Del día" elegido en la factura (sin tasa)       | NUNCA fija: se valoriza al día     |
 */

/** Tasa fijada **por factura** desde el 360 (`PATCH …/invoices/fx`): manda sobre la política del contrato en todos los caminos. */
export const PER_INVOICE_FX_SOURCES: ReadonlySet<string> = new Set(['manual', 'net_exact']);

/** Tasa que sale de las condiciones del contrato (por par): se respeta aunque la política general del contrato sea spot. */
export const CONTRACT_FX_SOURCES: ReadonlySet<string> = new Set(['contract', 'contract-change']);

/** Marca spot: sin tasa = "Del día" elegido en la factura; con tasa = valorizada por el envío. Nunca se conserva al emitir. */
export const SPOT_FX_SOURCE = 'spot';

/** Orígenes que conservan su tasa al emitir en un contrato **spot** (además, nada más se respeta: el resto se valoriza al día). */
const KEPT_IN_SPOT: ReadonlySet<string> = new Set([...PER_INVOICE_FX_SOURCES, ...CONTRACT_FX_SOURCES, 'manual_unify']);

/** ¿La línea tiene una tasa fijada por factura (manual o neto exacto)? */
export const isPerInvoiceFxSource = (source: string | null | undefined) => PER_INVOICE_FX_SOURCES.has(source ?? '');

/**
 * ¿Al emitir se conserva la tasa que ya tiene la línea? Regla por significado, no por lista de orígenes:
 * - sin tasa, o con la marca `spot`: no (se valoriza al día, o falta);
 * - contrato **fijo** (sin "Del día" elegido): sí, sea cual sea el origen, igual que la rama de una moneda del scheduler usa la tasa que haya;
 * - contrato **spot**: solo las fijadas por factura y las del propio contrato (`KEPT_IN_SPOT`).
 */
export function keepsRateAtIssue(source: string | null | undefined, rate: number | string | null | undefined, fixedPolicy: boolean): boolean {
	if (!(Number(rate) > 0)) return false;
	const value = source ?? '';

	if (value === SPOT_FX_SOURCE) return false;

	return fixedPolicy || KEPT_IN_SPOT.has(value);
}

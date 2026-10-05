/**
 * Reglas puras del consumo (Pricing v2 etapa 2, `docs/v2-rediseno/spec-pricing-v2.md` §4.3 y §4.4): qué líneas del período se
 * recalculan, cuándo se bloquea (factura emitida, período fuera del ítem), cómo se aplica la cantidad (`apply_as`: recalcular la
 * Por Emitir, factura complementaria con la diferencia o reemitir) y cómo quedan los montos de la línea y del encabezado.
 * También cubre ítems estándar (sin modelo de precio): cantidad × unitario del período. Sin base: recibe filas ya leídas.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';

import { fixedFxAmounts, round2 } from './billing-engine';
import { isCreditNote, PENDING_STATUS } from './contract-360';
import { type PricedLine, type PricedSubline, priceLine, type PriceLineOptions, type PriceSpec } from './pricing-engine';
/** Estados que dejan a la factura fuera de juego para el consumo (una anulada no bloquea: la Por Emitir de reemplazo se recalcula). */
export const VOID_STATUSES = new Set(['Cancelada', 'Anulada']);
/** Facturas unificadas (multi-contrato) no se recalculan desde un ítem. */
export const UNIFIED_INVOICE_TYPE = 'Unificada';

export const CONSUMPTION_PERIOD_ISSUED = 'consumption_period_issued';
export const PERIOD_OUT_OF_ITEM = 'period_out_of_item';
export const ITEM_NOT_METERED = 'item_not_metered';
export const NO_ADDITIONAL_CONSUMPTION = 'no_additional_consumption';

/**
 * Cómo se aplica la cantidad a la factura del período (§4.4). `recompute` (default): con la Por Emitir se recalcula; con la
 * emitida → 409 explicado. `additional`: factura complementaria Por Emitir con la diferencia (sirve con la Por Emitir y con la
 * emitida). `reissue`: NC espejo de la emitida + factura nueva (solo emitidas; con la Por Emitir equivale a `recompute`).
 */
export const APPLY_AS_MODES = ['recompute', 'additional', 'reissue'] as const;
export type ApplyAsMode = (typeof APPLY_AS_MODES)[number];
/** Alias histórico del body (`on_issued`): `block` = `recompute`. Se sigue aceptando y se devuelve junto a `apply_as`. */
export const ON_ISSUED_MODES = ['block', 'additional', 'reissue'] as const;
export type OnIssuedMode = (typeof ON_ISSUED_MODES)[number];
export const onIssuedOf = (mode: ApplyAsMode): OnIssuedMode => (mode === 'recompute' ? 'block' : mode);
/** `apply_as` efectivo del body: `apply_as` manda; si no viene, se traduce `on_issued`; sin ninguno, `recompute`. */
export const resolveApplyAs = (dto: { apply_as?: ApplyAsMode | null; on_issued?: OnIssuedMode | null }): ApplyAsMode =>
	dto.apply_as ?? (dto.on_issued === 'block' ? 'recompute' : dto.on_issued) ?? 'recompute';
/** Las dos salidas que ofrece el 409 `consumption_period_issued` (S7-8). */
export const ON_ISSUED_OPTIONS: Array<{ apply_as: Exclude<ApplyAsMode, 'recompute'>; on_issued: Exclude<OnIssuedMode, 'block'>; label: string }> = [
	{
		apply_as: 'additional',
		on_issued: 'additional',
		label: 'Facturar solo el consumo adicional en una factura complementaria Por Emitir del mismo período',
	},
	{
		apply_as: 'reissue',
		on_issued: 'reissue',
		label: 'Anular la factura emitida con una nota de crédito espejo y reemitir el período con el consumo corregido',
	},
];

/**
 * Línea tarifada de un ítem **estándar** (sin modelo de precio) con una cantidad informada: cantidad × unitario del período
 * (el que la activación dejó en la línea, `unit_price_contract_currency`) menos el descuento del ítem; desglose = una sublínea
 * `tier` "Por unidad" (más el descuento si aplica). Mismo cálculo que el generador para `standard` fijo.
 */
export function priceStandardLine(unitPrice: number, quantity: number, discountPct: number, options: PriceLineOptions = {}): PricedLine {
	const spec: PriceSpec = { model: 'standard', quantity_type: 'fixed', unit_amount: Number(unitPrice) || 0 };

	return priceLine(spec, quantity, discountPct, { ...options, quantity_source: options.quantity_source ?? 'consumption' });
}

/** Línea de factura del ítem para un período, con lo que hace falta del encabezado. */
export interface ConsumptionPeriodLine {
	line_id: string;
	invoice_id: string;
	invoice_number: string | null;
	status: string | null;
	is_active: boolean;
	is_legacy: boolean;
	invoice_type: string | null;
	document_type: string | null;
	issue_date: string | null;
	billing_period_start: string;
	billing_period_end: string;
	/** Descuento del ítem guardado en la línea al activar (porcentaje). */
	discount_pct: number;
	quantity: number;
	/** Unitario del período en moneda de contrato (`unit_price_contract_currency`); en ítems estándar es la base del recálculo. */
	unit_price?: number | null;
	subtotal: number;
	tax_rate: number;
	/** `fx_contract_to_invoice` de la factura: 1 misma moneda, tasa fija, o null (spot: se valoriza al emitir). */
	fx: number | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	/** Lo que hace falta para reescribir o clonar la línea (§3.8 `per_tier`, §4.4). Opcionales: las lecturas viejas no los traen. */
	description?: string | null;
	product_id?: string | null;
	unit_of_measure?: string | null;
	quantity_source?: string | null;
	pricing_breakdown?: PricedSubline[] | null;
	fx_rate_source?: string | null;
	/** Glosa escrita a mano (spec facturas §3.6): se conserva al recomponer las filas `per_tier`. */
	description_locked?: boolean;
	/** La factura está Cancelada "sin cobro" (todas sus líneas en 0, evento INVOICE_NO_CHARGE): el consumo la puede reactivar. */
	no_charge?: boolean;
	/** Borrador en el ERP de la factura (una Por Emitir con borrador no pasa a sin cobro: primero se restablece). */
	odoo_invoice_id?: number | null;
	/** Filas de la factura con cantidad o monto ≠ 0 fuera de este ítem y período (para saber si queda toda en 0). */
	other_nonzero_lines?: number;
	/** Total de la factura (moneda de factura, o de contrato si aún no se valorizó) para mostrar la emitida. */
	invoice_total?: number | null;
	/**
	 * La factura está anulada con una NC de anulación vinculada (etapa 6, §3.8; conserva su estado emitido): cuenta como anulada, así el
	 * consumo del período queda libre para la reemisión (o para registrarse de nuevo si no se reemitió).
	 */
	voided?: boolean;
}

/**
 * Clasificación de las líneas del ítem en el período (§4.3). `target`/`issued` es la primera fila de la factura elegida y
 * `target_lines`/`issued_lines` todas las de esa factura para el ítem y período (una en `single`, varias en `per_tier`).
 */
export type PeriodClassification =
	| {
			state: 'open';
			target: ConsumptionPeriodLine;
			target_lines: ConsumptionPeriodLine[];
			warnings: string[];
			/**
			 * La Por Emitir es una complementaria: factura a la que complementa (emitida, o la Por Emitir del período si la
			 * complementaria nació con `apply_as = additional` sobre ella) y sus filas: se recalcula la diferencia (§4.4).
			 */
			complements: { issued: ConsumptionPeriodLine; issued_lines: ConsumptionPeriodLine[] } | null;
	  }
	| { state: 'issued'; issued: ConsumptionPeriodLine; issued_lines: ConsumptionPeriodLine[] }
	| { state: 'void_only'; warnings: string[] }
	| { state: 'none' };

/** Filas de una misma factura, en el orden del grupo `per_tier` (`line_index`) o por id. */
export const linesOfInvoice = (lines: ConsumptionPeriodLine[], invoiceId: string) =>
	lines.filter((line) => line.invoice_id === invoiceId).sort((a, b) => lineIndex(a) - lineIndex(b) || a.line_id.localeCompare(b.line_id));
const lineIndex = (line: ConsumptionPeriodLine) => line.pricing_breakdown?.find((subline) => subline.line_index !== undefined)?.line_index ?? 0;

/** Cantidad del período que representan las filas de una factura: en `per_tier` la guardan las sublíneas; en `single`, la fila. */
export const periodQuantityOf = (lines: ConsumptionPeriodLine[]): number => {
	for (const line of lines) {
		const marked = line.pricing_breakdown?.find((subline) => subline.period_quantity !== undefined);

		if (marked) return Number(marked.period_quantity) || 0;
	}

	return lines[0]?.quantity ?? 0;
};

/** Anulada: estado Cancelada/Anulada o emitida con NC de anulación vinculada (§3.8). */
export const isVoidLine = (line: Pick<ConsumptionPeriodLine, 'status' | 'voided'>) => VOID_STATUSES.has(line.status ?? '') || line.voided === true;

/** Factura de tipo factura (no NC/ND), no unificada, no legacy y activa: la única que el consumo puede tocar. */
export const isRecomputable = (line: ConsumptionPeriodLine) =>
	line.is_active &&
	!line.is_legacy &&
	line.invoice_type !== UNIFIED_INVOICE_TYPE &&
	!isCreditNote(line.document_type) &&
	line.document_type !== 'ND';

/**
 * Clasifica las líneas del ítem cuyo período empieza en `period_start` (§4.3, pasos 1, 4 y 5):
 * - `open`: hay una Por Emitir activa → se recalcula (si hay más de una, la de emisión más próxima, con advertencia);
 * - `issued`: la(s) del período están emitidas y no anuladas → 409 `consumption_period_issued`, no se escribe nada;
 * - `void_only`: solo facturas anuladas/canceladas → la entry se guarda y la Por Emitir de reemplazo la tomará;
 * - `none`: el ítem no tiene línea en ese período → 409 `period_out_of_item`.
 */
export function classifyPeriodLines(lines: ConsumptionPeriodLine[]): PeriodClassification {
	if (!lines.length) return { state: 'none' };
	const candidates = lines.filter(isRecomputable);
	// Entre varias Por Emitir gana la complementaria (nació de `apply_as = additional` y lleva la diferencia); si no, la de
	// emisión más próxima.
	const complementary = (line: ConsumptionPeriodLine) => Boolean(line.pricing_breakdown?.some((subline) => subline.kind === 'invoiced'));
	const open = candidates
		.filter((line) => line.status === PENDING_STATUS)
		.sort(
			(a, b) =>
				Number(complementary(b)) - Number(complementary(a)) ||
				(a.issue_date ?? '9999-12-31').localeCompare(b.issue_date ?? '9999-12-31') ||
				a.line_id.localeCompare(b.line_id)
		);

	if (open.length) {
		const invoices = new Set(open.map((line) => line.invoice_id));
		const warnings =
			invoices.size > 1
				? [
						`El período tiene ${invoices.size} facturas Por Emitir para este ítem: se recalcula ${
							complementary(open[0]) ? 'la complementaria (solo la diferencia)' : 'la de emisión más próxima'
						}`,
					]
				: [];

		const targetLines = linesOfInvoice(open, open[0].invoice_id);
		// Si la Por Emitir es una complementaria (§4.4), la factura a la que complementa (emitida o Por Emitir) sigue vigente.
		const complementsId = complementsInvoiceId(targetLines);
		const issued = complementsId ? candidates.find((line) => line.invoice_id === complementsId && !isVoidLine(line)) : undefined;

		return {
			state: 'open',
			target: open[0],
			target_lines: targetLines,
			warnings,
			complements: issued ? { issued, issued_lines: linesOfInvoice(candidates, issued.invoice_id) } : null,
		};
	}
	const issued = candidates
		.filter((line) => !isVoidLine(line))
		.sort((a, b) => (b.issue_date ?? '').localeCompare(a.issue_date ?? '') || a.line_id.localeCompare(b.line_id))[0];

	if (issued) return { state: 'issued', issued, issued_lines: linesOfInvoice(candidates, issued.invoice_id) };
	// Sin Por Emitir ni emitida: una factura Cancelada "sin cobro" (todas sus líneas en 0) se recalcula y, si recupera cantidad, vuelve a
	// Por Emitir. Cualquier otra cancelada nunca se reactiva.
	const restorable = candidates
		.filter((line) => line.no_charge === true)
		.sort((a, b) => (a.issue_date ?? '9999-12-31').localeCompare(b.issue_date ?? '9999-12-31') || a.line_id.localeCompare(b.line_id));

	if (restorable.length) {
		return {
			state: 'open',
			target: restorable[0],
			target_lines: linesOfInvoice(restorable, restorable[0].invoice_id),
			warnings: [],
			complements: null,
		};
	}

	return { state: 'void_only', warnings: ['El período solo tiene facturas anuladas: el consumo queda guardado para la factura de reemplazo'] };
}

/** Factura emitida del período tal como la ve el front (`issued_invoice`). */
export interface IssuedInvoiceView {
	id: string;
	invoice_number: string | null;
	status: string | null;
	issue_date: string | null;
	total: number | null;
	currency: string | null;
}

export const issuedInvoiceView = (line: ConsumptionPeriodLine): IssuedInvoiceView => ({
	id: line.invoice_id,
	invoice_number: line.invoice_number,
	status: line.status,
	issue_date: line.issue_date,
	total: line.invoice_total ?? null,
	currency: line.invoice_currency,
});

/** Qué puede hacer la usuaria con la emitida: `additional_allowed` y, si no, por qué (`additional_reason`). */
export interface IssuedOutcome {
	issued_invoice: IssuedInvoiceView;
	additional_amount: number | null;
	additional_allowed: boolean;
	additional_reason: string | null;
}

/** Si la factura a la que se complementa está Por Emitir (complementaria sobre la del período, §4.4) o emitida. */
export const isPendingLine = (line: Pick<ConsumptionPeriodLine, 'status'>) => line.status === PENDING_STATUS;
/** Cómo nombrar la factura de referencia en mensajes y glosas. */
export const referenceLabel = (line: Pick<ConsumptionPeriodLine, 'invoice_number' | 'invoice_id' | 'status'>) =>
	line.invoice_number ?? (isPendingLine(line) ? `la factura Por Emitir ${line.invoice_id}` : line.invoice_id);

export const additionalReason = (
	diff: AdditionalDifference,
	invoiceNumber: string | null,
	currency: string | null,
	reference: Pick<ConsumptionPeriodLine, 'status'> = { status: null }
) =>
	isPendingLine(reference)
		? `No hay consumo adicional que facturar: el nuevo cálculo (${currency ?? ''} ${round2(diff.already_invoiced + diff.difference)}) no supera lo que ya lleva ${
				invoiceNumber ?? 'la factura Por Emitir del período'
			} (${currency ?? ''} ${diff.already_invoiced}); usa recalcular (apply_as = recompute)`.replace(/\s+/g, ' ')
		: `No hay consumo adicional que facturar: el nuevo cálculo (${currency ?? ''} ${round2(diff.already_invoiced + diff.difference)}) no supera lo ya facturado en ${
				invoiceNumber ?? 'la factura emitida'
			} (${currency ?? ''} ${diff.already_invoiced}); usa reemplazar (apply_as = reissue)`.replace(/\s+/g, ' ');

export const issuedOutcome = (line: ConsumptionPeriodLine, diff: AdditionalDifference | null): IssuedOutcome => ({
	issued_invoice: issuedInvoiceView(line),
	additional_amount: diff ? diff.difference : null,
	additional_allowed: Boolean(diff && diff.difference > 0),
	additional_reason: diff && diff.difference <= 0 ? additionalReason(diff, line.invoice_number, line.contract_currency, line) : null,
});

/**
 * 409 explicado del paso 4 (S7-7/S7-8) con las dos salidas (`options[]`) que el mismo PUT acepta en `on_issued`, la emitida
 * (`issued_invoice`) y si la complementaria es posible (`additional_amount`, `additional_allowed`, `additional_reason`).
 */
export const issuedConflict = (line: ConsumptionPeriodLine, diff: AdditionalDifference | null = null) =>
	new ConflictException({
		message: `La factura ${line.invoice_number ?? line.invoice_id} del período ya fue emitida: anula y reemite, o registra el consumo adicional`,
		code: CONSUMPTION_PERIOD_ISSUED,
		invoice: { id: line.invoice_id, invoice_number: line.invoice_number, status: line.status, issue_date: line.issue_date },
		options: ON_ISSUED_OPTIONS,
		...issuedOutcome(line, diff),
	});

/** Lo ya facturado del ítem en el período (factura emitida) frente al nuevo cálculo (§4.4, consumo adicional). */
export interface AdditionalDifference {
	already_invoiced: number;
	already_quantity: number;
	difference: number;
	quantity_difference: number;
}

export function additionalDifference(priced: Pick<PricedLine, 'quantity' | 'subtotal'>, issuedLines: ConsumptionPeriodLine[]): AdditionalDifference {
	const already = round2(issuedLines.reduce((sum, line) => sum + line.subtotal, 0));
	const alreadyQuantity = periodQuantityOf(issuedLines);

	return {
		already_invoiced: already,
		already_quantity: alreadyQuantity,
		difference: round2(priced.subtotal - already),
		quantity_difference: Math.max(0, priced.quantity - alreadyQuantity),
	};
}

/** 400 cuando el nuevo cálculo no supera lo que ya lleva la factura de referencia: no hay complementaria posible. */
export const noAdditionalConflict = (line: ConsumptionPeriodLine, diff: AdditionalDifference) =>
	new BadRequestException({
		message: additionalReason(diff, line.invoice_number, line.contract_currency, line),
		code: NO_ADDITIONAL_CONSUMPTION,
		already_invoiced: diff.already_invoiced,
		difference: diff.difference,
		...issuedOutcome(line, diff),
	});

/** Etiqueta de la sublínea `invoiced`: lo que ya lleva la factura de referencia (emitida o Por Emitir). */
export const invoicedLabel = (reference: Pick<ConsumptionPeriodLine, 'invoice_id' | 'invoice_number' | 'status'>) =>
	isPendingLine(reference)
		? `Ya incluido en ${reference.invoice_number ?? `la factura Por Emitir ${reference.invoice_id}`}`
		: `Ya facturado en ${reference.invoice_number ?? 'la factura emitida'}`;
/** Nombre de la factura de referencia a partir de su sublínea `invoiced`. */
export const invoicedReferenceName = (label: string) => label.replace(/^Ya (facturado|incluido) en (la factura (emitida|Por Emitir))?\s*/, '').trim();

/**
 * La única línea de la factura complementaria (§4.4): la diferencia entre el nuevo cálculo y lo que ya lleva la factura de
 * referencia (emitida, o la Por Emitir del período). Cantidad = unidades adicionales (o 1 si el consumo no subió pero el monto
 * sí), unitario = diferencia / cantidad, desglose = el nuevo completo más una sublínea `invoiced` negativa con lo ya incluido.
 */
export function additionalPricedLine(
	priced: PricedLine,
	diff: AdditionalDifference,
	issued: Pick<ConsumptionPeriodLine, 'invoice_id' | 'invoice_number'> & Partial<Pick<ConsumptionPeriodLine, 'status'>>
): PricedLine {
	const quantity = diff.quantity_difference > 0 ? diff.quantity_difference : 1;

	return {
		...priced,
		quantity,
		billable_quantity: quantity,
		subtotal: diff.difference,
		effective_unit_price: Math.round((diff.difference / quantity) * 1e6) / 1e6 || 0,
		breakdown: [
			...priced.breakdown.filter((subline) => subline.kind !== 'invoiced'),
			{
				kind: 'invoiced',
				quantity: diff.already_quantity,
				amount: -diff.already_invoiced,
				label: invoicedLabel({ ...issued, status: issued.status ?? null }),
				invoice_id: issued.invoice_id,
			},
		],
		warnings: [],
	};
}

/** La factura emitida a la que complementan unas filas (sublínea `invoiced`), o null si no son de una complementaria. */
export const complementsInvoiceId = (lines: Array<{ pricing_breakdown?: PricedSubline[] | null }>): string | null => {
	for (const line of lines) {
		const invoiced = line.pricing_breakdown?.find((subline) => subline.kind === 'invoiced');

		if (invoiced) return invoiced.invoice_id ?? null;
	}

	return null;
};
export const isComplementary = (lines: Array<{ pricing_breakdown?: PricedSubline[] | null }>) =>
	lines.some((line) => line.pricing_breakdown?.some((subline) => subline.kind === 'invoiced'));

/** 409 del paso 5: el ítem no tiene línea en ese período (terminado, fuera del ítem o período que no empieza ahí). */
export const outOfItemConflict = (periodStart: string, periods: string[]) =>
	new ConflictException({
		message: periods.length
			? `El ítem no tiene un período de servicio que empiece el ${periodStart}. Períodos del ítem: ${periods.join(', ')}`
			: `El ítem no tiene períodos de servicio facturables (sin facturas o contrato sin activar)`,
		code: PERIOD_OUT_OF_ITEM,
		periods,
	});

/**
 * 409 de un ítem estándar (sin modelo de precio) cuando la factura del período ya se emitió y se pidió `recompute`: la cantidad
 * solo puede ir como complementaria o reemisión. Con la Por Emitir, el ítem estándar se recalcula como cualquier otro.
 */
export const notMeteredConflict = (productName: string | null, issued: ConsumptionPeriodLine | null = null) =>
	new ConflictException({
		message: `El ítem "${productName ?? ''}" no se factura por consumo y la factura ${
			issued ? (issued.invoice_number ?? issued.invoice_id) : ''
		} del período ya fue emitida: registra la cantidad como consumo adicional (apply_as = additional) o reemite (apply_as = reissue)`.replace(
			/\s+/g,
			' '
		),
		code: ITEM_NOT_METERED,
		...(issued
			? {
					invoice: { id: issued.invoice_id, invoice_number: issued.invoice_number, status: issued.status, issue_date: issued.issue_date },
					options: ON_ISSUED_OPTIONS,
				}
			: {}),
	});

export interface LineAmounts {
	quantity: number;
	unit_price_contract_currency: number;
	unit_price_invoice_currency: number | null;
	subtotal_contract_currency: number;
	subtotal_invoice_currency: number | null;
	tax_amount_contract_currency: number;
	tax_amount_invoice_currency: number | null;
	total_contract_currency: number;
	total_invoice_currency: number | null;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 || 0;

/**
 * Montos de la línea recalculada: en moneda de contrato siempre; en moneda de factura solo con FX conocido (1 o fijo), como
 * `fixedFxAmounts`. `tax` explícito cuando el IVA ya se repartió entre filas (`per_tier`, `distributeTax`).
 */
export function lineAmounts(
	priced: Pick<PricedLine, 'quantity' | 'effective_unit_price' | 'subtotal'>,
	taxRate: number,
	fx: number | null,
	tax = round2((priced.subtotal * taxRate) / 100)
): LineAmounts {
	const total = round2(priced.subtotal + tax);

	return {
		quantity: priced.quantity,
		unit_price_contract_currency: priced.effective_unit_price,
		unit_price_invoice_currency: fx === null ? null : round6(priced.effective_unit_price * fx),
		subtotal_contract_currency: priced.subtotal,
		subtotal_invoice_currency: fx === null ? null : round2(priced.subtotal * fx),
		tax_amount_contract_currency: tax,
		tax_amount_invoice_currency: fx === null ? null : round2(tax * fx),
		total_contract_currency: total,
		total_invoice_currency: fx === null ? null : round2(total * fx),
	};
}

export interface HeaderAmounts {
	amount_contract_currency: number;
	vat: number;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
}

/**
 * @deprecated Usa `headerFromLines` (convención única: Σ de los montos redondeados de las líneas). Se conserva solo para los llamadores que
 * no son de las operaciones de factura del 360 (consumo y modificaciones, de otro dueño), hasta que migren.
 *
 * Encabezado = Σ líneas (misma regla que la activación): con la misma moneda, IVA y total son la suma de las líneas; con
 * tipo de cambio fijo, los montos en moneda de factura salen de `fixedFxAmounts` con la tasa de la factura (nunca clonada);
 * con spot (fx null) quedan en NULL y se valorizan al emitir.
 */
export function headerAmounts(sumSubtotal: number, sumTax: number, taxRate: number, fx: number | null): HeaderAmounts {
	const subtotal = round2(sumSubtotal);
	const tax = round2(sumTax);

	if (fx === null) return { amount_contract_currency: subtotal, vat: tax, amount_invoice_currency: null, total_invoice_currency: null };
	if (fx === 1)
		return { amount_contract_currency: subtotal, vat: tax, amount_invoice_currency: subtotal, total_invoice_currency: round2(subtotal + tax) };
	const fixed = fixedFxAmounts({ subtotal, tax_rate: taxRate, lines: [] }, fx);

	return { amount_contract_currency: subtotal, vat: fixed.vat, amount_invoice_currency: fixed.amount, total_invoice_currency: fixed.total };
}

/** Una línea tal como la suma `headerFromLines`: acepta los nombres de `LineState` (`tax_*`) y los de la fila (`tax_amount_*`). */
export interface HeaderLine {
	subtotal_contract_currency: number;
	subtotal_invoice_currency: number | null;
	tax_contract_currency?: number;
	tax_amount_contract_currency?: number;
	tax_invoice_currency?: number | null;
	tax_amount_invoice_currency?: number | null;
}

export interface HeaderFromLinesOptions {
	/** Factura y contrato en la misma moneda: los montos en moneda de factura = los de contrato. */
	sameCurrency: boolean;
	/** Tasa de la factura (null = spot sin valorizar: el encabezado en moneda de factura queda NULL). */
	fx: number | null;
	/** IVA en % (solo para completar el IVA en moneda de factura de una línea valorizada que no lo tiene). */
	taxRate: number;
}

const lineTaxContract = (line: HeaderLine) => Number(line.tax_contract_currency ?? line.tax_amount_contract_currency ?? 0) || 0;
const lineTaxInvoice = (line: HeaderLine): number | null => {
	const value = line.tax_invoice_currency !== undefined ? line.tax_invoice_currency : line.tax_amount_invoice_currency;

	return value === undefined || value === null ? null : Number(value) || 0;
};

/**
 * **Convención única del encabezado** (spec facturas §3.2/§3.4): encabezado = Σ de los montos YA REDONDEADOS de las líneas, en ambas monedas.
 * `amount_contract_currency` = Σ subtotales en moneda de contrato; misma moneda → monto e IVA en moneda de factura = los de contrato; spot
 * (`fx` null) → monto y total en moneda de factura NULL y `vat` en moneda de contrato; tasa fija → Σ subtotales e IVA en moneda de factura
 * de las líneas (una línea aún sin valorizar aporta su monto × tasa) y total = monto + IVA. Los centavos residuales de convertir a tasa fija
 * los absorbe la línea más grande al valorizar (`fixedFxLines`, `netExactFx`), nunca el encabezado.
 */
export function headerFromLines(lines: HeaderLine[], options: HeaderFromLinesOptions): HeaderAmounts {
	const amount = round2(lines.reduce((sum, line) => sum + (Number(line.subtotal_contract_currency) || 0), 0));
	const taxContract = round2(lines.reduce((sum, line) => sum + lineTaxContract(line), 0));

	if (options.sameCurrency)
		return {
			amount_contract_currency: amount,
			vat: taxContract,
			amount_invoice_currency: amount,
			total_invoice_currency: round2(amount + taxContract),
		};
	if (options.fx === null)
		return { amount_contract_currency: amount, vat: taxContract, amount_invoice_currency: null, total_invoice_currency: null };
	const fx = options.fx;
	let invoiceAmount = 0;
	let invoiceTax = 0;

	for (const line of lines) {
		const subtotal =
			line.subtotal_invoice_currency === null || line.subtotal_invoice_currency === undefined
				? round2((Number(line.subtotal_contract_currency) || 0) * fx)
				: Number(line.subtotal_invoice_currency) || 0;
		const tax =
			lineTaxInvoice(line) ??
			(line.subtotal_invoice_currency === null || line.subtotal_invoice_currency === undefined
				? round2(lineTaxContract(line) * fx)
				: round2((subtotal * options.taxRate) / 100));

		invoiceAmount += subtotal;
		invoiceTax += tax;
	}
	invoiceAmount = round2(invoiceAmount);
	invoiceTax = round2(invoiceTax);

	return {
		amount_contract_currency: amount,
		vat: invoiceTax,
		amount_invoice_currency: invoiceAmount,
		total_invoice_currency: round2(invoiceAmount + invoiceTax),
	};
}

/** Descuento del ítem en porcentaje para el recálculo: el que quedó en la línea al activar; si no, el del ítem (solo `Porcentaje`). */
export function discountPctFor(line: { discount_pct: number }, item: { discount_type: string | null; discount_value: number | null }): number {
	if (Number.isFinite(line.discount_pct) && line.discount_pct > 0) return Math.min(100, line.discount_pct);
	if (item.discount_type === 'Monto fijo') return 0;

	return Math.min(100, Math.max(0, Number(item.discount_value ?? 0) || 0));
}

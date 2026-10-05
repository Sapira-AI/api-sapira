import { BadRequestException, ConflictException } from '@nestjs/common';

import {
	additionalDifference,
	additionalPricedLine,
	classifyPeriodLines,
	complementsInvoiceId,
	CONSUMPTION_PERIOD_ISSUED,
	type ConsumptionPeriodLine,
	discountPctFor,
	headerAmounts,
	invoicedLabel,
	invoicedReferenceName,
	isComplementary,
	isRecomputable,
	issuedConflict,
	lineAmounts,
	NO_ADDITIONAL_CONSUMPTION,
	noAdditionalConflict,
	notMeteredConflict,
	ON_ISSUED_OPTIONS,
	onIssuedOf,
	outOfItemConflict,
	PERIOD_OUT_OF_ITEM,
	periodQuantityOf,
	priceStandardLine,
	resolveApplyAs,
} from './consumption';
import { priceLine, type PriceSpec } from './pricing-engine';

/** Precio del mockup (§3.5) para las pruebas de complementaria. */
const mockupPrice: PriceSpec = {
	model: 'graduated',
	quantity_type: 'metered',
	billable_metric_id: 'm',
	tiers: [
		{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
		{ from: 501, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
		{ from: 2001, to: null, per_unit_amount: 0.045, flat_amount: 0 },
	],
	free_units: 100,
};

const line = (overrides: Partial<ConsumptionPeriodLine> = {}): ConsumptionPeriodLine => ({
	line_id: 'l-1',
	invoice_id: 'inv-1',
	invoice_number: 'F-100',
	status: 'Por Emitir',
	is_active: true,
	is_legacy: false,
	invoice_type: 'Automatica',
	document_type: 'FACTURA',
	issue_date: '2026-11-01',
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	discount_pct: 10,
	quantity: 1000,
	subtotal: 64.8,
	tax_rate: 19,
	fx: 1,
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	...overrides,
});

describe('classifyPeriodLines (§4.3 pasos 1, 4 y 5)', () => {
	it('sin líneas → none; una Por Emitir activa → open', () => {
		expect(classifyPeriodLines([])).toEqual({ state: 'none' });
		expect(classifyPeriodLines([line()])).toEqual({ state: 'open', target: line(), target_lines: [line()], warnings: [], complements: null });
	});

	it('varias Por Emitir del mismo período: la de emisión más próxima, con advertencia', () => {
		const result = classifyPeriodLines([
			line({ line_id: 'b', invoice_id: 'inv-b', issue_date: '2026-12-01' }),
			line({ line_id: 'a', invoice_id: 'inv-a' }),
		]);

		expect(result.state).toBe('open');
		expect(result.state === 'open' && result.target.line_id).toBe('a');
		expect(result.state === 'open' && result.warnings[0]).toContain('2 facturas Por Emitir');
	});

	it('emitida y no anulada → issued (aunque haya una anulada del mismo período); solo anuladas → void_only', () => {
		const issued = classifyPeriodLines([
			line({ status: 'Cancelada', invoice_id: 'old' }),
			line({ status: 'Pagada', invoice_id: 'paid', invoice_number: 'F-7' }),
		]);

		expect(issued.state).toBe('issued');
		expect(issued.state === 'issued' && issued.issued.invoice_number).toBe('F-7');
		expect(classifyPeriodLines([line({ status: 'Enviada' })]).state).toBe('issued');
		expect(classifyPeriodLines([line({ status: 'Anulada' })]).state).toBe('void_only');
		expect(classifyPeriodLines([line({ status: 'Cancelada' })]).state).toBe('void_only');
	});

	it('NC/ND, unificadas, legacy e inactivas nunca se recalculan ni bloquean por sí solas', () => {
		expect(isRecomputable(line({ document_type: 'NC' }))).toBe(false);
		expect(isRecomputable(line({ document_type: 'ND' }))).toBe(false);
		expect(isRecomputable(line({ invoice_type: 'Unificada' }))).toBe(false);
		expect(isRecomputable(line({ is_legacy: true }))).toBe(false);
		expect(isRecomputable(line({ is_active: false }))).toBe(false);
		expect(isRecomputable(line())).toBe(true);
		// Una NC emitida del período no bloquea; la Por Emitir se recalcula igual.
		expect(classifyPeriodLines([line({ document_type: 'NC', status: 'Emitida', invoice_id: 'nc' }), line()]).state).toBe('open');
		// Unificada histórica (sin evento v2) emitida: no es candidata → período sin factura propia (void_only), no emitida.
		expect(classifyPeriodLines([line({ invoice_type: 'Unificada', status: 'Pagada' })]).state).toBe('void_only');
	});

	it('consolidación (Domi 05-10): el origen de un unificado v2 Por Emitir se recalcula; el unificado v2 emitido es la emitida del período', () => {
		const origin = line({ is_active: false, consolidated_into_invoice_id: 'u-1', consolidated_pending: true });
		const copy = line({ line_id: 'l-u', invoice_id: 'u-1', invoice_type: 'Unificada', unified_v2: true });

		expect(isRecomputable(origin)).toBe(true);
		// La copia Por Emitir no se toca (sus líneas se re-copian desde los orígenes).
		expect(isRecomputable(copy)).toBe(false);
		expect(classifyPeriodLines([origin, copy])).toMatchObject({
			state: 'open',
			target: { line_id: origin.line_id, invoice_id: origin.invoice_id },
		});
		// Origen de un unificado ya emitido: inactivo y sin `consolidated_pending` → no candidato; el unificado emitido manda.
		const issuedCopy = line({ line_id: 'l-u', invoice_id: 'u-1', invoice_type: 'Unificada', unified_v2: true, status: 'Emitida' });

		expect(isRecomputable(issuedCopy)).toBe(true);
		expect(classifyPeriodLines([line({ is_active: false, consolidated_into_invoice_id: 'u-1' }), issuedCopy])).toMatchObject({
			state: 'issued',
			issued: { invoice_id: 'u-1' },
		});
	});
});

describe('errores explicados (409)', () => {
	it('consumption_period_issued nombra la factura y el paso siguiente', () => {
		const error = issuedConflict(line({ status: 'Pagada' }));

		expect(error).toBeInstanceOf(ConflictException);
		expect(error.getResponse()).toMatchObject({
			code: CONSUMPTION_PERIOD_ISSUED,
			message: 'La factura F-100 del período ya fue emitida: anula y reemite, o registra el consumo adicional',
			invoice: { id: 'inv-1', invoice_number: 'F-100', status: 'Pagada' },
		});
	});

	it('period_out_of_item lista los períodos del ítem; item_not_metered nombra el ítem', () => {
		expect(outOfItemConflict('2026-10-15', ['2026-10-01', '2026-11-01']).getResponse()).toMatchObject({
			code: PERIOD_OUT_OF_ITEM,
			message: 'El ítem no tiene un período de servicio que empiece el 2026-10-15. Períodos del ítem: 2026-10-01, 2026-11-01',
			periods: ['2026-10-01', '2026-11-01'],
		});
		expect((outOfItemConflict('2026-10-01', []).getResponse() as { message: string }).message).toContain('sin facturas o contrato sin activar');
		// Ítem estándar con la factura del período emitida y apply_as = recompute: nombra el ítem, la factura y las dos salidas.
		const notMetered = notMeteredConflict('Soporte', line({ status: 'Pagada' })).getResponse() as Record<string, unknown>;

		expect(notMetered).toMatchObject({
			code: 'item_not_metered',
			message:
				'El ítem "Soporte" no se factura por consumo y la factura F-100 del período ya fue emitida: registra la cantidad como consumo adicional (apply_as = additional) o reemite (apply_as = reissue)',
			invoice: { id: 'inv-1', invoice_number: 'F-100', status: 'Pagada' },
			options: ON_ISSUED_OPTIONS,
		});
	});
});

describe('apply_as (alias on_issued) e ítems estándar', () => {
	it('resolveApplyAs: apply_as manda; on_issued se traduce (block = recompute); sin nada, recompute; onIssuedOf devuelve el alias', () => {
		expect(resolveApplyAs({})).toBe('recompute');
		expect(resolveApplyAs({ on_issued: 'block' })).toBe('recompute');
		expect(resolveApplyAs({ on_issued: 'additional' })).toBe('additional');
		expect(resolveApplyAs({ on_issued: 'reissue' })).toBe('reissue');
		expect(resolveApplyAs({ apply_as: 'additional', on_issued: 'block' })).toBe('additional');
		expect(resolveApplyAs({ apply_as: 'recompute', on_issued: 'reissue' })).toBe('recompute');
		expect(['recompute', 'additional', 'reissue'].map((mode) => onIssuedOf(mode as 'recompute'))).toEqual(['block', 'additional', 'reissue']);
	});

	it('priceStandardLine: cantidad × unitario del período menos el descuento; desglose = una sublínea tier "Por unidad" (+ descuento)', () => {
		expect(priceStandardLine(100, 5, 0)).toEqual({
			quantity: 5,
			quantity_source: 'consumption',
			billable_quantity: 5,
			subtotal: 500,
			effective_unit_price: 100,
			breakdown: [{ kind: 'tier', quantity: 5, unit_amount: 100, amount: 500, label: 'Por unidad' }],
			warnings: [],
		});
		const discounted = priceStandardLine(100, 5, 10, { quantity_source: 'estimated' });

		expect(discounted).toMatchObject({ subtotal: 450, effective_unit_price: 90, quantity_source: 'estimated' });
		expect(discounted.breakdown.map((subline) => [subline.kind, subline.amount])).toEqual([
			['tier', 500],
			['discount', -50],
		]);
		expect(priceStandardLine(100, 0, 0)).toMatchObject({ quantity: 0, subtotal: 0, breakdown: [] });
		// Monto informado: manda sobre cantidad × unitario.
		expect(priceStandardLine(100, 5, 0, { amount_override: 320 })).toMatchObject({ subtotal: 320, quantity: 5 });
	});

	it('invoicedLabel distingue emitida y Por Emitir; invoicedReferenceName recupera el nombre de la factura', () => {
		expect(invoicedLabel(line({ status: 'Pagada' }))).toBe('Ya facturado en F-100');
		expect(invoicedLabel(line({ status: 'Pagada', invoice_number: null }))).toBe('Ya facturado en la factura emitida');
		expect(invoicedLabel(line())).toBe('Ya incluido en F-100');
		expect(invoicedLabel(line({ invoice_number: null }))).toBe('Ya incluido en la factura Por Emitir inv-1');
		expect(invoicedReferenceName('Ya facturado en F-0042')).toBe('F-0042');
		expect(invoicedReferenceName('Ya incluido en F-0042')).toBe('F-0042');
		expect(invoicedReferenceName('Ya incluido en la factura Por Emitir inv-1')).toBe('inv-1');
		expect(invoicedReferenceName('Ya facturado en la factura emitida')).toBe('');
	});

	it('la complementaria de una Por Emitir: entre varias Por Emitir gana la complementaria y complements apunta a la del período (Por Emitir)', () => {
		const periodLine = line({ line_id: 'l-period', invoice_id: 'inv-oct', invoice_number: null, issue_date: '2026-11-01' });
		const extraLine = line({
			line_id: 'l-extra',
			invoice_id: 'inv-extra',
			invoice_number: null,
			issue_date: '2026-12-15',
			quantity: 250,
			subtotal: 13.5,
			pricing_breakdown: [
				{ kind: 'invoiced', quantity: 1000, amount: -64.8, label: 'Ya incluido en la factura Por Emitir inv-oct', invoice_id: 'inv-oct' },
			],
		});
		const result = classifyPeriodLines([periodLine, extraLine]);

		expect(result.state).toBe('open');
		if (result.state !== 'open') return;
		expect(result.target.line_id).toBe('l-extra');
		expect(result.warnings[0]).toBe('El período tiene 2 facturas Por Emitir para este ítem: se recalcula la complementaria (solo la diferencia)');
		expect(result.complements).toEqual({ issued: periodLine, issued_lines: [periodLine] });
		// Sin complementaria, sigue ganando la de emisión más próxima.
		const plain = classifyPeriodLines([periodLine, line({ line_id: 'l-b', invoice_id: 'inv-b', issue_date: '2026-12-01' })]);

		expect(plain.state === 'open' && plain.target.line_id).toBe('l-period');
	});

	it('additionalDifference contra lo que ya lleva la Por Emitir; el 400 y la sublínea invoiced hablan de "incluido", no de "facturado"', () => {
		const pending = line();
		const diff = additionalDifference(priceLine(mockupPrice, 1250, 10), [pending]);

		expect(diff).toEqual({ already_invoiced: 64.8, already_quantity: 1000, difference: 13.5, quantity_difference: 250 });
		expect(additionalPricedLine(priceLine(mockupPrice, 1250, 10), diff, pending).breakdown.at(-1)).toMatchObject({
			kind: 'invoiced',
			amount: -64.8,
			label: 'Ya incluido en F-100',
			invoice_id: 'inv-1',
		});
		const lower = additionalDifference(priceLine(mockupPrice, 300, 10), [pending]);

		expect((noAdditionalConflict(pending, lower).getResponse() as { message: string }).message).toBe(
			'No hay consumo adicional que facturar: el nuevo cálculo (CLP 23.4) no supera lo que ya lleva F-100 (CLP 64.8); usa recalcular (apply_as = recompute)'
		);
	});
});

describe('montos de línea y encabezado', () => {
	const priced = priceLine({ model: 'standard', quantity_type: 'metered', billable_metric_id: 'm', unit_amount: 2 }, 50, 0, {
		quantity_source: 'consumption',
	});

	it('misma moneda (fx 1): montos iguales en las dos monedas; IVA por línea a 2 decimales', () => {
		expect(lineAmounts(priced, 19, 1)).toEqual({
			quantity: 50,
			unit_price_contract_currency: 2,
			unit_price_invoice_currency: 2,
			subtotal_contract_currency: 100,
			subtotal_invoice_currency: 100,
			tax_amount_contract_currency: 19,
			tax_amount_invoice_currency: 19,
			total_contract_currency: 119,
			total_invoice_currency: 119,
		});
	});

	it('spot (fx null): los montos en moneda de factura quedan NULL y se valorizan al emitir', () => {
		expect(lineAmounts(priced, 19, null)).toMatchObject({
			subtotal_contract_currency: 100,
			subtotal_invoice_currency: null,
			total_invoice_currency: null,
			unit_price_invoice_currency: null,
		});
		expect(headerAmounts(100, 19, 19, null)).toEqual({
			amount_contract_currency: 100,
			vat: 19,
			amount_invoice_currency: null,
			total_invoice_currency: null,
		});
	});

	it('tipo de cambio fijo: misma regla que apply_fixed_fx_to_contract (unitario a 6, montos a 2; encabezado con fixedFxAmounts)', () => {
		expect(lineAmounts(priced, 19, 0.0011)).toMatchObject({
			unit_price_invoice_currency: 0.0022,
			subtotal_invoice_currency: 0.11,
			tax_amount_invoice_currency: 0.02,
			total_invoice_currency: 0.13,
		});
		expect(headerAmounts(100, 19, 19, 0.0011)).toEqual({
			amount_contract_currency: 100,
			vat: 0.02,
			amount_invoice_currency: 0.11,
			total_invoice_currency: 0.13,
		});
		expect(headerAmounts(100.004, 19.001, 19, 1)).toEqual({
			amount_contract_currency: 100,
			vat: 19,
			amount_invoice_currency: 100,
			total_invoice_currency: 119,
		});
	});

	it('el descuento del recálculo es el de la línea; sin él, el del ítem (solo Porcentaje)', () => {
		expect(discountPctFor({ discount_pct: 10 }, { discount_type: 'Porcentaje', discount_value: 25 })).toBe(10);
		expect(discountPctFor({ discount_pct: 0 }, { discount_type: 'Porcentaje', discount_value: 25 })).toBe(25);
		expect(discountPctFor({ discount_pct: 0 }, { discount_type: 'Monto fijo', discount_value: 25 })).toBe(0);
		expect(discountPctFor({ discount_pct: 0 }, { discount_type: null, discount_value: null })).toBe(0);
	});
});

describe('classifyPeriodLines · per_tier y complementarias (§3.8, §4.4)', () => {
	it('junta las filas per_tier de la misma factura en target_lines, ordenadas por line_index, y recupera la cantidad del período', () => {
		const rows = [
			line({
				line_id: 'l-b',
				quantity: 750,
				subtotal: 45,
				pricing_breakdown: [{ kind: 'tier', quantity: 750, amount: 45, label: 'T2', period_quantity: 1250, line_index: 1, line_count: 3 }],
			}),
			line({
				line_id: 'l-c',
				quantity: 1,
				subtotal: -8.7,
				pricing_breakdown: [{ kind: 'discount', quantity: 0, amount: -8.7, label: 'D', period_quantity: 1250, line_index: 2, line_count: 3 }],
			}),
			line({
				line_id: 'l-a',
				quantity: 400,
				subtotal: 42,
				pricing_breakdown: [{ kind: 'tier', quantity: 400, amount: 42, label: 'T1', period_quantity: 1250, line_index: 0, line_count: 3 }],
			}),
			line({ line_id: 'l-other', invoice_id: 'inv-2', issue_date: '2026-12-01' }),
		];
		const result = classifyPeriodLines(rows);

		expect(result.state).toBe('open');
		if (result.state !== 'open') throw new Error('open');
		expect(result.target.line_id).toBe('l-a');
		expect(result.target_lines.map((row) => row.line_id)).toEqual(['l-a', 'l-b', 'l-c']);
		expect(periodQuantityOf(result.target_lines)).toBe(1250);
		expect(periodQuantityOf([line({ quantity: 1000 })])).toBe(1000);
		expect(result.warnings[0]).toContain('2 facturas Por Emitir');
		expect(result.complements).toBeNull();
	});

	it('una Por Emitir complementaria apunta a la emitida a la que complementa (sublínea invoiced) y la clasificación la expone', () => {
		const issued = line({ line_id: 'l-paid', invoice_id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada', subtotal: 64.8 });
		const complementary = line({
			line_id: 'l-comp',
			invoice_id: 'inv-comp',
			quantity: 250,
			subtotal: 13.5,
			pricing_breakdown: [{ kind: 'invoiced', quantity: 1000, amount: -64.8, label: 'Ya facturado en F-0042', invoice_id: 'inv-paid' }],
		});
		const result = classifyPeriodLines([issued, complementary]);

		expect(result.state).toBe('open');
		if (result.state !== 'open') throw new Error('open');
		expect(result.target.line_id).toBe('l-comp');
		expect(result.complements?.issued.invoice_id).toBe('inv-paid');
		expect(result.complements?.issued_lines.map((row) => row.line_id)).toEqual(['l-paid']);
		expect(isComplementary([complementary])).toBe(true);
		expect(complementsInvoiceId([complementary])).toBe('inv-paid');
		expect(isComplementary([issued])).toBe(false);
		// Emitida más reciente gana cuando hay dos emitidas no anuladas.
		const two = classifyPeriodLines([issued, line({ line_id: 'l-new', invoice_id: 'inv-new', status: 'Emitida', issue_date: '2026-12-01' })]);

		expect(two.state === 'issued' && two.issued.invoice_id).toBe('inv-new');
	});
});

describe('consumo adicional (§4.4)', () => {
	const issuedLines = [
		line({ line_id: 'l-paid', invoice_id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada', quantity: 1000, subtotal: 64.8 }),
	];

	it('additionalDifference: nuevo cálculo − lo emitido, con las unidades de más; additionalPricedLine arma la línea única con la sublínea invoiced', () => {
		const priced = priceLine(mockupPrice, 1250, 10);
		const diff = additionalDifference(priced, issuedLines);

		expect(diff).toEqual({ already_invoiced: 64.8, already_quantity: 1000, difference: 13.5, quantity_difference: 250 });
		const extra = additionalPricedLine(priced, diff, issuedLines[0]);

		expect(extra).toMatchObject({ quantity: 250, subtotal: 13.5, effective_unit_price: 0.054 });
		expect(extra.breakdown.at(-1)).toEqual({
			kind: 'invoiced',
			quantity: 1000,
			amount: -64.8,
			label: 'Ya facturado en F-0042',
			invoice_id: 'inv-paid',
		});
		expect(extra.breakdown.reduce((sum, subline) => sum + subline.amount, 0)).toBeCloseTo(13.5, 10);
		// Misma cantidad pero más monto (p. ej. monto informado): cantidad 1 y unitario = diferencia.
		const sameQty = additionalPricedLine(
			priceLine(mockupPrice, 1000, 0),
			additionalDifference(priceLine(mockupPrice, 1000, 0), issuedLines),
			issuedLines[0]
		);

		expect(sameQty).toMatchObject({ quantity: 1, subtotal: 7.2, effective_unit_price: 7.2 });
		// Volver a pasar una línea que ya tenía invoiced no la duplica.
		expect(additionalPricedLine(extra, diff, issuedLines[0]).breakdown.filter((subline) => subline.kind === 'invoiced')).toHaveLength(1);
	});

	it('409 consumption_period_issued lleva la emitida, si la complementaria es posible y las dos opciones; 400 no_additional_consumption explica por qué', () => {
		const issued = { ...issuedLines[0], invoice_total: 77.11 };
		const ok = issuedConflict(issued, additionalDifference(priceLine(mockupPrice, 1250, 10), issuedLines)).getResponse() as Record<
			string,
			unknown
		>;

		expect(ok).toMatchObject({
			code: CONSUMPTION_PERIOD_ISSUED,
			issued_invoice: { id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada', issue_date: '2026-11-01', total: 77.11, currency: 'CLP' },
			additional_amount: 13.5,
			additional_allowed: true,
			additional_reason: null,
			options: ON_ISSUED_OPTIONS,
		});
		expect(ON_ISSUED_OPTIONS.map((option) => option.on_issued)).toEqual(['additional', 'reissue']);
		expect(ON_ISSUED_OPTIONS.map((option) => option.apply_as)).toEqual(['additional', 'reissue']);
		const lower = additionalDifference(priceLine(mockupPrice, 300, 10), issuedLines);
		const blocked = issuedConflict(issued, lower).getResponse() as Record<string, unknown>;

		expect(blocked).toMatchObject({ additional_amount: -41.4, additional_allowed: false });
		expect(blocked.additional_reason).toBe(
			'No hay consumo adicional que facturar: el nuevo cálculo (CLP 23.4) no supera lo ya facturado en F-0042 (CLP 64.8); usa reemplazar (apply_as = reissue)'
		);
		const bad = noAdditionalConflict(issued, lower);

		expect(bad).toBeInstanceOf(BadRequestException);
		expect(bad.getResponse()).toMatchObject({
			code: NO_ADDITIONAL_CONSUMPTION,
			additional_allowed: false,
			already_invoiced: 64.8,
			difference: -41.4,
		});
		// Sin diferencia calculada (solo la emitida): allowed false y sin motivo.
		expect(issuedConflict(issued).getResponse()).toMatchObject({ additional_amount: null, additional_allowed: false, additional_reason: null });
	});

	it('lineAmounts acepta el IVA repartido de per_tier', () => {
		expect(lineAmounts({ quantity: 1, effective_unit_price: -8.7, subtotal: -8.7 }, 19, 1, -1.65)).toMatchObject({
			tax_amount_contract_currency: -1.65,
			total_contract_currency: -10.35,
			total_invoice_currency: -10.35,
		});
	});
});

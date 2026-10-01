import { classifyPeriodLines, type ConsumptionPeriodLine } from './consumption';
import { partialBillingOf, relatedDocumentsOf } from './contract-360';
import { mirrorCreditNoteAmounts } from './contract-changes';
import { withInternalLines } from './contracts.service';
import { type DeviationPlan, type EditContext, type EditInvoiceRow, type EditItem, type EditLineRow } from './invoice-edit';
import {
	type IssuedInvoiceRow,
	planDiscountCreditNote,
	planReissue,
	planVoid,
	reissueEditContext,
	remainingRatios,
	voidCreditReason,
} from './invoice-void';

import type { ContractInvoiceContext } from './contract-invoices';

const ITEM = 'item-1';
const OTHER = 'item-2';
const TODAY = '2026-09-30';

const issued = (overrides: Partial<IssuedInvoiceRow & EditInvoiceRow> = {}): IssuedInvoiceRow & EditInvoiceRow => ({
	id: 'inv-1',
	invoice_number: 'F-100',
	status: 'Emitida',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-09-05',
	original_issue_date: '2026-09-05',
	scheduled_at: '2026-09-05',
	due_date: '2026-10-05',
	contract_currency: 'USD',
	invoice_currency: 'CLP',
	amount_contract_currency: 1333.33,
	amount_invoice_currency: 1266663.5,
	vat: 240666.06,
	total_invoice_currency: 1507329.56,
	fx_contract_to_invoice: 950,
	tax_rate: 19,
	fx_rate_source: 'contract',
	fx_confirmed_at: null,
	issued_externally: false,
	odoo_invoice_id: 77,
	sent_to_odoo_at: '2026-09-05T10:00:00Z',
	sent_at: null,
	no_charge: false,
	auto_invoice: false,
	requires_references: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-09-01',
	period_end: '2026-09-30',
	lines_count: 3,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1333.33,
	client_tax_id: '76.000.000-1',
	export_type: 0,
	invoice_terms_and_conditions: null,
	notes: null,
	nc_revenue_treatment: null,
	voided: false,
	paid: false,
	...overrides,
});

const line = (overrides: Partial<EditLineRow> = {}): EditLineRow => ({
	id: 'line-a',
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma - Periodo 01/09/2026 a 30/09/2026',
	description_locked: false,
	quantity: 10,
	unit_of_measure: 'UND',
	discount_pct: 0,
	unit_price: 100,
	subtotal: 1000,
	tax_amount: 190,
	total: 1190,
	unit_price_invoice: 95000,
	subtotal_invoice: 950000,
	tax_amount_invoice: 180500,
	total_invoice: 1130500,
	billing_period_start: '2026-09-01',
	billing_period_end: '2026-09-30',
	quantity_source: 'fixed',
	pricing_breakdown: null,
	...overrides,
});

const lines = (): EditLineRow[] => [
	line(),
	// IVA en moneda de factura guardado 1 centavo distinto de subtotal × 19 % (redondeo del ERP): la NC lo copia tal cual.
	line({
		id: 'line-b',
		contract_item_id: OTHER,
		product_id: 'prod-2',
		product_name: 'Soporte',
		description: 'Soporte',
		quantity: 1,
		unit_price: 333.33,
		subtotal: 333.33,
		tax_amount: 63.33,
		total: 396.66,
		unit_price_invoice: 316663.5,
		subtotal_invoice: 316663.5,
		tax_amount_invoice: 60166.06,
		total_invoice: 376829.56,
	}),
	line({ id: 'line-c', quantity: 0, subtotal: 0, tax_amount: 0, total: 0, subtotal_invoice: 0, tax_amount_invoice: 0, total_invoice: 0 }),
];

const context = (overrides: Partial<ContractInvoiceContext> = {}): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: 'fixed',
	contract_requires_references: false,
	auto_send_to_erp: false,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: null,
	company_country: 'Chile',
	has_erp_integration: true,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: TODAY,
	...overrides,
});

const item = (id: string, name: string): EditItem => ({
	id,
	product_id: `prod-${id}`,
	product_name: name,
	account: null,
	unit_of_measure: 'UND',
	price: null,
	price_id: null,
	price_owner: null,
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	churn_date: null,
	term_months: 12,
});

const deviationPlan = (): DeviationPlan => ({
	expected: new Map([
		[`${ITEM}|2026-09-01`, 1000],
		[`${OTHER}|2026-09-01`, 333.33],
	]),
	known_items: new Set([ITEM, OTHER]),
	// La emitida se excluye de "otras facturas": la reemisión toma su lugar.
	others: new Map(),
	product_names: new Map([
		[ITEM, 'Plataforma'],
		[OTHER, 'Soporte'],
	]),
});

const editCtx = (overrides: Partial<EditContext> = {}): EditContext => ({
	invoice: issued(),
	context: context(),
	company_tax_rate: 19,
	contract_number: 'CTR-2026-001',
	client_name: 'Cliente SpA',
	template: null,
	max_chars: 80,
	lines: lines(),
	items: new Map([
		[ITEM, item(ITEM, 'Plataforma')],
		[OTHER, item(OTHER, 'Soporte')],
	]),
	issued_periods: [
		{
			contract_item_id: ITEM,
			billing_period_start: '2026-09-01',
			billing_period_end: '2026-09-30',
			invoice_id: 'inv-1',
			invoice_number: 'F-100',
		},
	],
	receiver: null,
	references: [],
	plan: deviationPlan(),
	...overrides,
});

const codes = (list: Array<{ code: string }>) => list.map((entry) => entry.code);

describe('invoice-void (spec facturas §3.8 y §8, lógica pura)', () => {
	describe('planVoid: NC espejo exacta', () => {
		it('espeja cada línea con monto al centavo en ambas monedas (IVA guardado, no recalculado), omite las ocultas en 0 y la NC nace Por Emitir sin vencimiento', () => {
			const plan = planVoid(issued(), lines(), context(), { reason: 'issue_error', reissue: false });

			expect(plan.blockers).toEqual([]);
			expect(plan.mirror.map((entry) => [entry.line.id, entry.ratio, entry.period_start])).toEqual([
				['line-a', 1, '2026-09-01'],
				['line-b', 1, '2026-09-01'],
			]);
			expect(plan.credit_note).toMatchObject({
				credit_type: 'cancellation',
				credit_reason: 'issue_error',
				nc_revenue_treatment: null,
				status: 'Por Emitir',
				due_date: null,
				issue_date: TODAY,
				related_invoice_id: 'inv-1',
				fx_contract_to_invoice: 950,
			});
			// Encabezado de la NC = −encabezado de la original, en moneda de contrato y de factura (IVA en moneda de factura).
			expect(plan.credit_note.totals).toEqual({
				amount_contract_currency: -1333.33,
				amount_invoice_currency: -1266663.5,
				vat: -240666.06,
				total_invoice_currency: -1507329.56,
			});
			expect(plan.credit_note.lines[1]).toMatchObject({
				source_line_id: 'line-b',
				contract_item_id: OTHER,
				subtotal_contract_currency: -333.33,
				tax_contract_currency: -63.33,
				subtotal_invoice_currency: -316663.5,
				tax_invoice_currency: -60166.06,
				total_invoice_currency: -376829.56,
			});
			expect(plan.rsm_from_month).toBe('2026-09-01');
			expect(codes(plan.warnings)).toEqual(['credit_note_to_erp']);
		});

		it('sin `exact` la NC recalcularía el IVA (subtotal × tasa): por eso la anulación usa el IVA guardado', () => {
			const [, second] = lines();
			const recomputed = mirrorCreditNoteAmounts([{ line: { ...second, subtotal_invoice: second.subtotal_invoice }, ratio: 1 }], 19);
			const exact = mirrorCreditNoteAmounts([{ line: second, ratio: 1 }], 19, true);

			expect(recomputed.tax_invoice).toBe(60166.07);
			expect(exact.tax_invoice).toBe(60166.06);
		});

		it('solicitud del cliente → credit_reason other (el CHECK no tiene client_request); issue_error se conserva', () => {
			expect(voidCreditReason('client_request')).toBe('other');
			expect(voidCreditReason('other')).toBe('other');
			expect(voidCreditReason('issue_error')).toBe('issue_error');
			expect(planVoid(issued(), lines(), context(), { reason: 'client_request', reissue: true }).credit_note.credit_reason).toBe('other');
		});

		it('bloqueos: already_voided, not_issued (Por Emitir), unificada, legacy, período cerrado; NC → solo credit_note', () => {
			expect(codes(planVoid(issued({ voided: true }), lines(), context(), { reason: 'other', reissue: false }).blockers)).toEqual([
				'already_voided',
			]);
			expect(codes(planVoid(issued({ status: 'Por Emitir' }), lines(), context(), { reason: 'other', reissue: false }).blockers)).toEqual([
				'not_issued',
			]);
			expect(
				codes(
					planVoid(issued({ invoice_type: 'Unificada', is_legacy: true }), lines(), context({ cutoff_date: '2026-09-30' }), {
						reason: 'other',
						reissue: false,
					}).blockers
				)
			).toEqual(['unified_invoice', 'legacy_invoice', 'period_closed']);
			expect(
				codes(planVoid(issued({ document_type: 'NC', voided: true }), lines(), context(), { reason: 'other', reissue: false }).blockers)
			).toEqual(['credit_note']);
		});

		it('pagada → aviso paid_invoice_voided (no bloquea)', () => {
			const plan = planVoid(issued({ status: 'Pagada', paid: true, odoo_invoice_id: null, sent_to_odoo_at: null }), lines(), context(), {
				reason: 'issue_error',
				reissue: false,
			});

			expect(plan.blockers).toEqual([]);
			expect(codes(plan.warnings)).toEqual(['paid_invoice_voided']);
		});
	});

	describe('planReissue: la reemisión pasa por el editor', () => {
		it('sin cambios: copia exacta de líneas y encabezado, Por Emitir de hoy, vencimiento por condición de pago, sin folio ni ERP, notas "Reemplaza a F-100"', () => {
			const plan = planReissue(editCtx(), null);

			expect(plan.blockers).toEqual([]);
			expect(plan.errors).toEqual([]);
			expect(plan.lines.map((entry) => [entry.id, entry.action])).toEqual([
				['line-a', 'unchanged'],
				['line-b', 'unchanged'],
				['line-c', 'unchanged'],
			]);
			expect(plan.header.after).toMatchObject({
				status: 'Por Emitir',
				issue_date: TODAY,
				original_issue_date: TODAY,
				due_date: '2026-10-30',
				notes: 'Reemplaza a F-100',
				amount_contract_currency: 1333.33,
				amount_invoice_currency: 1266663.5,
				vat: 240666.06,
				total_invoice_currency: 1507329.56,
				fx_contract_to_invoice: 950,
			});
			expect(plan.deviation.changed).toBe(false);
		});

		it('el contexto de reemisión saca a la emitida de los períodos emitidos (no choca overlaps_issued)', () => {
			expect(reissueEditContext(editCtx(), TODAY).issued_periods).toEqual([]);
		});

		it('con cambios: misma lógica del editor (línea editada a mano, encabezado = Σ líneas) y pide motivo si se desvía del plan', () => {
			const plan = planReissue(editCtx(), {
				issue_date: '2026-10-01',
				notes: 'Corrige cantidad',
				lines: [
					{
						id: 'line-a',
						contract_item_id: ITEM,
						quantity: 8,
						unit_price: 100,
						billing_period_start: '2026-09-01',
						billing_period_end: '2026-09-30',
					},
				],
			});
			const edited = plan.lines.find((entry) => entry.id === 'line-a')!;

			expect(edited.action).toBe('update');
			expect(edited.after).toMatchObject({
				quantity: 8,
				subtotal_contract_currency: 800,
				subtotal_invoice_currency: 760000,
				quantity_source: 'manual',
			});
			expect(plan.header.after).toMatchObject({
				issue_date: '2026-10-01',
				notes: 'Reemplaza a F-100 · Corrige cantidad',
				amount_contract_currency: 1133.33,
			});
			expect(plan.deviation).toMatchObject({ has_deviation: true, changed: true, reason_required: true, total_diff: -200 });
		});
	});

	describe('planDiscountCreditNote: NC de descuento parcial', () => {
		const items = new Map([
			[ITEM, item(ITEM, 'Plataforma')],
			[OTHER, item(OTHER, 'Soporte')],
		]);

		it('por monto (moneda de factura): una línea negativa con el ratio en ambas monedas, IVA con la tasa de la original y devengo impact_month', () => {
			const plan = planDiscountCreditNote(issued(), lines(), [], context(), items, {
				lines: [{ line_id: 'line-a', amount: 95000 }],
				reason: 'one_time_discount',
				revenue_treatment: 'impact_month',
			});

			expect(plan.errors).toEqual([]);
			expect(plan.can_apply).toBe(true);
			expect(plan.credit_note).toMatchObject({
				credit_type: 'discount',
				credit_reason: 'one_time_discount',
				nc_revenue_treatment: 'impact_month',
				due_date: null,
			});
			expect(plan.credit_note.lines).toEqual([
				expect.objectContaining({
					source_line_id: 'line-a',
					contract_item_id: ITEM,
					billing_period_start: '2026-09-01',
					subtotal_contract_currency: -100,
					subtotal_invoice_currency: -95000,
					tax_contract_currency: -19,
					tax_invoice_currency: -18050,
				}),
			]);
			expect(plan.credit_note.totals).toEqual({
				amount_contract_currency: -100,
				amount_invoice_currency: -95000,
				vat: -18050,
				total_invoice_currency: -113050,
			});
			expect(plan.lines).toEqual([
				{
					line_id: 'line-a',
					contract_item_id: ITEM,
					original_amount: 950000,
					previously_credited: 0,
					requested: 95000,
					remaining_after: 855000,
				},
			]);
			expect(plan.revenue_effect).toEqual({ treatment: 'impact_month', total: -100, by_month: [{ month: '2026-09-01', amount: -100 }] });
			expect(plan.rsm_from_month).toBe('2026-09-01');
		});

		it('por porcentaje sobre todas las líneas con monto; service_period reparte en los meses del período', () => {
			const plan = planDiscountCreditNote(issued(), lines(), [], context(), items, {
				pct: 10,
				reason: 'prompt_payment_discount',
				revenue_treatment: 'service_period',
			});

			expect(plan.lines.map((entry) => [entry.line_id, entry.requested])).toEqual([
				['line-a', 95000],
				['line-b', 31666.35],
			]);
			expect(plan.credit_note.totals.amount_contract_currency).toBe(-133.33);
			expect(plan.revenue_effect.by_month).toEqual([{ month: '2026-09-01', amount: -133.33 }]);
		});

		it('exceeds_line: lo pedido supera lo que queda de la línea tras las NC de descuento previas (mismo ítem y período)', () => {
			const plan = planDiscountCreditNote(
				issued(),
				lines(),
				[
					{
						contract_item_id: ITEM,
						billing_period_start: '2026-09-01',
						billing_period_end: '2026-09-30',
						subtotal: -947.37,
						subtotal_invoice: -900000,
					},
				],
				context(),
				items,
				{ lines: [{ line_id: 'line-a', pct: 10 }], reason: 'compensation', revenue_treatment: 'defer_forward' }
			);

			expect(codes(plan.blockers)).toEqual(['exceeds_line']);
			expect(plan.blockers[0].message).toContain('le quedan 50000');
			expect(plan.lines[0]).toMatchObject({ previously_credited: 900000, requested: 95000, remaining_after: -45000 });
			expect(plan.can_apply).toBe(false);
		});

		it('errores de forma: lines y pct a la vez, línea ajena, sin monto ni %; bloqueos de emitida', () => {
			expect(
				planDiscountCreditNote(issued(), lines(), [], context(), items, {
					lines: [{ line_id: 'line-a', amount: 1 }],
					pct: 5,
					reason: 'other',
					revenue_treatment: 'impact_month',
				}).errors.map((error) => error.field)
			).toEqual(['lines']);
			expect(
				planDiscountCreditNote(issued(), lines(), [], context(), items, {
					lines: [{ line_id: 'otra' }, { line_id: 'line-c', amount: 5 }, { line_id: 'line-b' }],
					reason: 'other',
					revenue_treatment: 'impact_month',
				}).errors.map((error) => error.field)
			).toEqual(['lines.0.line_id', 'lines.1.line_id', 'lines.2.amount']);
			expect(
				codes(
					planDiscountCreditNote(issued({ voided: true, status: 'Por Emitir' }), lines(), [], context(), items, {
						pct: 5,
						reason: 'other',
						revenue_treatment: 'impact_month',
					}).blockers
				)
			).toEqual(['not_issued', 'already_voided']);
		});
	});

	describe('lectura y consumo', () => {
		it('una emitida anulada con NC (conserva su estado) libera el consumo del período: cuenta como anulada', () => {
			const periodLine = (overrides: Partial<ConsumptionPeriodLine>): ConsumptionPeriodLine => ({
				line_id: 'l-1',
				invoice_id: 'inv-1',
				invoice_number: 'F-100',
				status: 'Emitida',
				is_active: true,
				is_legacy: false,
				invoice_type: 'Automatica',
				document_type: 'FACTURA',
				issue_date: '2026-09-05',
				billing_period_start: '2026-09-01',
				billing_period_end: '2026-09-30',
				discount_pct: 0,
				quantity: 10,
				subtotal: 1000,
				tax_rate: 19,
				fx: 1,
				contract_currency: 'USD',
				invoice_currency: 'USD',
				...overrides,
			});

			expect(classifyPeriodLines([periodLine({})]).state).toBe('issued');
			expect(classifyPeriodLines([periodLine({ voided: true })]).state).toBe('void_only');
			expect(
				classifyPeriodLines([periodLine({ voided: true }), periodLine({ line_id: 'l-2', invoice_id: 'inv-2', status: 'Por Emitir' })]).state
			).toBe('open');
		});

		it('related_documents, partial_billing e internal_lines se arman desde la lectura', () => {
			expect(
				relatedDocumentsOf([
					{
						id: 'nc-1',
						invoice_number: null,
						document_type: 'NC',
						credit_type: 'cancellation',
						status: 'Por Emitir',
						issue_date: '2026-09-30',
						total: '-1507329.56',
						relation: 'credit_note',
					},
				])
			).toEqual([
				{
					id: 'nc-1',
					invoice_number: null,
					document_type: 'NC',
					credit_type: 'cancellation',
					status: 'Por Emitir',
					issue_date: '2026-09-30',
					total: -1507329.56,
					relation: 'credit_note',
				},
			]);
			const metadata = { invoice_id: 'inv-1', remainder_invoice_id: 'inv-2', reference: { type: 'OC', code: '4500' }, covered_total: 750 };

			expect(partialBillingOf('inv-1', metadata)).toEqual({
				role: 'covered',
				reference_code: '4500',
				reference_type: 'OC',
				covered_total: 750,
				covered_invoice_id: 'inv-1',
				remainder_invoice_id: 'inv-2',
			});
			expect(partialBillingOf('inv-2', JSON.stringify(metadata))?.role).toBe('remainder');
			expect(partialBillingOf('inv-1', null)).toBeNull();
			const grouped = withInternalLines([
				{ id: 'v', visible_line_id: null },
				{ id: 'a', visible_line_id: 'v' },
				{ id: 'b', visible_line_id: 'v' },
				{ id: 'x', visible_line_id: null },
			]);

			expect(grouped.map((entry) => [entry.id, entry.internal_lines.map((internal) => internal.id)])).toEqual([
				['v', ['a', 'b']],
				['a', []],
				['b', []],
				['x', []],
			]);
		});
	});
	describe('auditoría 01-10: NC previas y facturas por OC', () => {
		const items = new Map([
			[ITEM, item(ITEM, 'Plataforma')],
			[OTHER, item(OTHER, 'Soporte')],
		]);
		const previous = [
			{
				credit_note_id: 'nc-7',
				credit_note_number: 'NC-7',
				contract_item_id: ITEM,
				billing_period_start: '2026-09-01',
				billing_period_end: '2026-09-30',
				subtotal: -100,
				subtotal_invoice: -95000,
			},
		];
		/** Factura por OC: visible del documento (montos en 0, unitario = neto de la OC) + dos internas ligadas. */
		const poLines = (): EditLineRow[] => [
			line({
				id: 'line-v',
				description: 'Servicios según OC 4500',
				description_locked: true,
				quantity: 1,
				unit_price: 1333.33,
				unit_price_invoice: 1266663.5,
				subtotal: 0,
				tax_amount: 0,
				total: 0,
				subtotal_invoice: 0,
				tax_amount_invoice: 0,
				total_invoice: 0,
				quantity_source: 'manual',
			}),
			{ ...lines()[0], visible_line_id: 'line-v' },
			{ ...lines()[1], visible_line_id: 'line-v' },
		];

		it('anular con NC de descuento vigentes: acredita lo que queda de cada línea y avisa previous_credit_notes_considered (no bloquea)', () => {
			const plan = planVoid(issued(), lines(), context(), { reason: 'issue_error', reissue: false }, previous);

			expect(plan.blockers).toEqual([]);
			expect(codes(plan.warnings)).toContain('previous_credit_notes_considered');
			expect(plan.warnings.find((warning) => warning.code === 'previous_credit_notes_considered')?.message).toContain('NC-7');
			expect(plan.mirror.map((entry) => [entry.line.id, entry.ratio])).toEqual([
				['line-a', 0.9],
				['line-b', 1],
			]);
			expect(plan.credit_note.totals.amount_invoice_currency).toBe(-(855000 + 316663.5));
			expect(remainingRatios(issued(), lines(), previous).get('line-a')).toBe(0.9);
		});

		it('anular una factura ya acreditada completa por NC de descuento: no queda monto (no_lines)', () => {
			const all = [
				...previous.map((entry) => ({ ...entry, subtotal: -1000, subtotal_invoice: -950000 })),
				{ ...previous[0], contract_item_id: OTHER, subtotal: -333.33, subtotal_invoice: -316663.5 },
			];
			const plan = planVoid(issued(), lines(), context(), { reason: 'issue_error', reissue: false }, all);

			expect(codes(plan.blockers)).toEqual(['no_lines']);
			expect(plan.blockers[0].message).toContain('ya acreditan toda la factura');
		});

		it('anular una factura por OC: la NC espeja la visible del documento y sus internas', () => {
			const plan = planVoid(issued({ internal_lines: 2 }), poLines(), context(), { reason: 'issue_error', reissue: false });

			expect(plan.blockers).toEqual([]);
			expect(plan.mirror.map((entry) => [entry.line.id, entry.line.visible_line_id, entry.ratio])).toEqual([
				['line-v', null, 1],
				['line-a', 'line-v', 1],
				['line-b', 'line-v', 1],
			]);
			// La visible no suma al encabezado (montos en 0): Σ líneas = el documento.
			expect(plan.credit_note.totals.amount_invoice_currency).toBe(-1266663.5);
		});

		it('NC de descuento por % sobre una factura por OC: el ratio del documento a la visible y a cada interna (Σ internas = lo pedido)', () => {
			const plan = planDiscountCreditNote(issued({ internal_lines: 2 }), poLines(), [], context(), items, {
				pct: 10,
				reason: 'compensation',
				revenue_treatment: 'impact_month',
			});

			expect(plan.errors).toEqual([]);
			expect(plan.blockers).toEqual([]);
			expect(codes(plan.warnings)).toContain('partial_billing_whole_document');
			expect(plan.mirror.map((entry) => [entry.line.id, Math.round(entry.ratio * 1e6) / 1e6])).toEqual([
				['line-v', 0.1],
				['line-a', 0.1],
				['line-b', 0.1],
			]);
			expect(plan.lines.map((entry) => [entry.line_id, entry.requested])).toEqual([
				['line-a', 95000],
				['line-b', 31666.35],
			]);
			expect(plan.credit_note.totals.amount_invoice_currency).toBe(-126666.35);
			expect(plan.revenue_effect.by_month.length).toBeGreaterThan(0);
		});

		it('NC de descuento por monto sobre la visible de una OC (o sobre internas): se convierte al ratio del documento', () => {
			const byVisible = planDiscountCreditNote(issued({ internal_lines: 2 }), poLines(), [], context(), items, {
				lines: [{ line_id: 'line-v', amount: 126666.35 }],
				reason: 'compensation',
				revenue_treatment: 'impact_month',
			});
			const byInternal = planDiscountCreditNote(issued({ internal_lines: 2 }), poLines(), [], context(), items, {
				lines: [{ line_id: 'line-a', amount: 126666.35 }],
				reason: 'compensation',
				revenue_treatment: 'impact_month',
			});

			for (const plan of [byVisible, byInternal]) {
				expect(plan.lines.map((entry) => entry.requested)).toEqual([95000, 31666.35]);
				expect(plan.mirror[0].line.id).toBe('line-v');
			}
		});

		it('partial_billing de una reemisión: el evento de su original (chain_invoice_id) le da el rol', () => {
			const metadata = {
				invoice_id: 'inv-1',
				remainder_invoice_id: 'inv-2',
				reference: { type: 'OC', code: '4500' },
				chain_invoice_id: 'inv-1',
			};

			expect(partialBillingOf('inv-9', metadata)).toMatchObject({ role: 'covered', covered_invoice_id: 'inv-1', reference_code: '4500' });
			expect(partialBillingOf('inv-8', { ...metadata, chain_invoice_id: 'inv-2' })?.role).toBe('remainder');
		});
	});
});

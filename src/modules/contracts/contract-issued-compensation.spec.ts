/**
 * Rebaja con fecha efectiva anterior a facturas ya emitidas, modo "compensar en próximas facturas" (`change.issued_overcharge =
 * compensate_next`, Domi 16-11, caso real S07212). Fixture base: Licencia 10 × 100 y Soporte 1 × 200, enero a diciembre de 2026, emitidas
 * hasta septiembre y Por Emitir de octubre a diciembre; hoy 28-09-2026.
 */
import { type ChangeContext, type ChangeInvoiceLineRow, type ChangeInvoiceRow, type ChangePlan, planChange } from './contract-changes';
import { context, contractRow, invoiceRow, itemRow, LICENCIA, request, SOPORTE, soporteRow } from './contract-changes.test-fixtures';
import { compensationMarker, compensationOf } from './overcharge-compensation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const lineOp = (plan: ChangePlan, lineId: string) =>
	(ops(plan, 'update_line') as Array<{ line_id: string; values: Record<string, unknown> }>).find((op) => op.line_id === lineId);
const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const invoices = (line: (mm: string, row: ChangeInvoiceLineRow) => Partial<ChangeInvoiceLineRow> = () => ({})): ChangeInvoiceRow[] =>
	MONTHS.map((mm) => {
		const invoice = invoiceRow(mm);

		return { ...invoice, lines: invoice.lines.map((row) => ({ ...row, ...(row.contract_item_id === LICENCIA ? line(mm, row) : {}) })) };
	});
const COMPENSATE = { issued_overcharge: 'compensate_next' as const };
const downsell = (effective: string, quantity = 7, change: Record<string, unknown> = {}, overrides: Partial<ChangeContext> = {}) =>
	planChange(
		context(overrides),
		request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity, unit_price: 100 }], ...change }, { effective_date: effective })
	);

describe('rebaja con fecha anterior a lo emitido · compensar en próximas facturas', () => {
	it('sin el modo, todo sigue como hoy: bloquea con nota de crédito y la vista previa ofrece la opción', () => {
		const plan = downsell('2026-09-01');

		expect(plan.preview.can_apply).toBe(false);
		expect(plan.preview.blockers[0]).toMatchObject({
			code: 'issued_after_effective_date',
			next_step: expect.stringContaining('compensar lo cobrado de más en las próximas facturas'),
		});
		expect(plan.preview.issued_compensation_available).toBe(true);
		expect(plan.preview.issued_compensation).toBeUndefined();
		// Un aumento con la misma fecha no ofrece la opción (el upsell retroactivo no cambia).
		expect(downsell('2026-09-01', 12).preview.issued_compensation_available).toBeUndefined();
	});

	it('anticipado: la baja rige desde su fecha real, lo emitido no se toca y la próxima línea del mismo producto sale con menos cantidad', () => {
		const plan = downsell('2026-09-01', 7, COMPENSATE);

		expect(plan.preview.blockers).toEqual([]);
		// Contrato, ítems, MRR y devengo desde la fecha real.
		expect(ops(plan, 'insert_item')[0].item).toMatchObject({
			categoria: 'DOWNSELL',
			quantity: 3,
			unit_price: -100,
			start_date: '2026-09-01',
			end_date: '2026-12-31',
			related_item_id: LICENCIA,
		});
		expect(plan.preview.rsm).toMatchObject({ mrr_delta: -300, first_month: '2026-09-01' });
		expect(plan.preview.contract.after.mrr).toBe(900);
		// Cobro en exceso: septiembre emitido con 10 × 100, debió ser 7 × 100.
		expect(plan.preview.issued_compensation).toEqual([
			{
				item_id: LICENCIA,
				product_name: 'Licencia',
				currency: 'CLP',
				mode: 'quantity',
				amount: 300,
				issued: [
					{
						invoice_id: 'inv-09',
						invoice_number: 'F-09',
						issue_date: '2026-09-01',
						period_start: '2026-09-01',
						period_end: '2026-09-30',
						issued: 1000,
						expected: 700,
						overcharge: 300,
					},
				],
				compensated: [
					{
						invoice_id: 'inv-10',
						invoice_number: null,
						issue_date: '2026-10-01',
						period_start: '2026-10-01',
						period_end: '2026-10-31',
						line_before: 700,
						amount: 300,
						line_after: 400,
						quantity_before: 7,
						quantity_after: 4,
						unit_price_before: 100,
						unit_price_after: 100,
					},
				],
				pending_balance: 0,
			},
		]);
		// No hay descuento: las 3 licencias facturadas de más en septiembre cubren parte de octubre, que sale con 7 − 3 = 4 al mismo
		// precio. Sin líneas negativas. La marca del desglose vale 0 y guarda la cuenta.
		const october = lineOp(plan, 'line-10-lic')!.values;

		expect(october).toMatchObject({ quantity: 4, unit_price: 100, discount_pct: 0, subtotal: 400, tax_amount: 76, total: 476 });
		expect(october.pricing_breakdown).toEqual([
			{
				kind: 'compensation',
				quantity: 0,
				amount: 0,
				label: '7 del período menos 3 ya facturados en sep 2026 (3 x 1)',
				compensation: {
					item_id: LICENCIA,
					periods: [{ invoice_id: 'inv-09', invoice_number: 'F-09', period_start: '2026-09-01', period_end: '2026-09-30', amount: 300 }],
					mode: 'quantity',
					count: { quantity: 3, months: 1 },
					base_quantity: 7,
					base_unit_price: 100,
					units: 3,
					amount: 300,
				},
			},
		]);
		expect(october.description).toBe('Licencia - Periodo 01/10/2026 a 31/10/2026. 7 del periodo menos 3 ya facturados en sep 2026 (3 x 1)');
		// La factura que compensa más la ya emitida suman el total con el ajuste: 1.000 (sep) + 400 (oct) = 2 meses × 7 × 100.
		expect(1000 + Number(october.subtotal)).toBe(2 * 7 * 100);
		// Las demás Por Emitir quedan al valor nuevo, sin ajuste.
		expect(lineOp(plan, 'line-11-lic')!.values).toMatchObject({ quantity: 7, subtotal: 700, discount_pct: 0 });
		expect(lineOp(plan, 'line-11-lic')!.values.pricing_breakdown).toBeUndefined();
		expect(plan.preview.invoices.updated.map((entry) => [entry.id, entry.subtotal_before, entry.subtotal_after])).toEqual([
			['inv-10', 1200, 600],
			['inv-11', 1200, 900],
			['inv-12', 1200, 900],
		]);
		// Ninguna nota de crédito ni operación sobre emitidas; un ajuste "downsell" por factura destino.
		expect(plan.preview.invoices.credit_notes).toEqual([]);
		expect(plan.ops.some((op) => 'invoice_id' in op && /inv-0\d/.test(String(op.invoice_id)))).toBe(false);
		expect(ops(plan, 'insert_invoice_adjustment')).toEqual([
			expect.objectContaining({ invoice_id: 'inv-10', type: 'downsell', amount_diff: -300, notes: expect.stringContaining('F-09') }),
		]);
		expect(codes(plan.preview.warnings)).toEqual(['issued_overcharge_compensated']);
		// Trazabilidad en el evento.
		expect(plan.event).toMatchObject({ type: 'DOWNSELL', amount_delta: -300, rsm_from_month: '2026-09-01' });
		expect(plan.event.description).toContain('lo cobrado de más en lo ya emitido (CLP 300,00)');
		expect(plan.event.metadata).toMatchObject({ issued_overcharge: 'compensate_next', issued_compensation: plan.preview.issued_compensation });
	});

	it('vencido: mismos períodos de servicio, facturas emitidas al mes siguiente', () => {
		const plan = planChange(
			context({
				items: [itemRow({ billing_method: 'Vencido' }), soporteRow()],
				invoices: MONTHS.map((mm) =>
					invoiceRow(mm, { issue_date: mm === '12' ? '2027-01-01' : `2026-${String(Number(mm) + 1).padStart(2, '0')}-01` })
				),
			}),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 7, unit_price: 100 }], ...COMPENSATE },
				{ effective_date: '2026-08-01' }
			)
		);
		const [compensation] = plan.preview.issued_compensation!;

		expect(plan.preview.blockers).toEqual([]);
		expect(compensation.issued.map((row) => [row.invoice_number, row.period_start, row.overcharge])).toEqual([
			['F-08', '2026-08-01', 300],
			['F-09', '2026-09-01', 300],
		]);
		expect(compensation.compensated.map((row) => [row.invoice_id, row.period_start, row.amount, row.line_after, row.quantity_after])).toEqual([
			['inv-10', '2026-10-01', 600, 100, 1],
		]);
		expect(lineOp(plan, 'line-10-lic')!.values).toMatchObject({ quantity: 1, unit_price: 100, discount_pct: 0, subtotal: 100 });
	});

	it('ítem con descuento: el exceso se mide con el descuento del ítem y la línea conserva solo ese descuento', () => {
		const plan = planChange(
			context({
				items: [
					itemRow({ discount_type: 'Porcentaje', discount_value: 20, monthly_price: 800, price: 9600, final_price: 9600 }),
					soporteRow(),
				],
				invoices: invoices(() => ({ discount_pct: 20, subtotal: 800, tax_amount: 152, total: 952 })).map((invoice) => ({
					...invoice,
					subtotal: 1000,
					vat: 190,
				})),
			}),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 7, unit_price: 100 }], ...COMPENSATE },
				{ effective_date: '2026-09-01' }
			)
		);
		const october = lineOp(plan, 'line-10-lic')!.values;

		// 10 × 100 × 0,8 = 800 → 7 × 100 × 0,8 = 560: exceso 240 = 3 licencias. Octubre: 4 × 100 × 0,8 = 320, con el 20 % del ítem y nada más.
		expect(plan.preview.issued_compensation![0]).toMatchObject({ amount: 240, pending_balance: 0 });
		expect(october).toMatchObject({ quantity: 4, unit_price: 100, subtotal: 320, discount_pct: 20 });
		expect(compensationOf(october.pricing_breakdown as never)).toMatchObject({
			amount: 0,
			label: '7 del período menos 3 ya facturados en sep 2026 (3 x 1)',
			compensation: expect.objectContaining({ mode: 'quantity', base_quantity: 7, units: 3, amount: 240 }),
		});
		expect(lineOp(plan, 'line-11-lic')!.values).toMatchObject({ subtotal: 560, discount_pct: 20 });
	});

	it('baja de precio: la cantidad no cambia y la línea que compensa sale con menor precio unitario, sin descuento', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 70 }], ...COMPENSATE },
				{ effective_date: '2026-09-01' }
			)
		);
		const [compensation] = plan.preview.issued_compensation!;
		const october = lineOp(plan, 'line-10-lic')!.values;

		// Septiembre emitido a 10 × 100 y debió ser 10 × 70: 300 de más. Octubre: 10 × (70 − 30) = 400.
		expect(plan.preview.blockers).toEqual([]);
		expect(compensation).toMatchObject({ mode: 'unit_price', amount: 300, pending_balance: 0 });
		expect(compensation.compensated[0]).toMatchObject({
			quantity_before: 10,
			quantity_after: 10,
			unit_price_before: 70,
			unit_price_after: 40,
			line_before: 700,
			line_after: 400,
		});
		expect(october).toMatchObject({ quantity: 10, unit_price: 40, discount_pct: 0, subtotal: 400 });
		expect(compensationOf(october.pricing_breakdown as never)).toMatchObject({
			label: 'Precio del período 70 menos lo ya facturado de más en sep 2026',
			compensation: expect.objectContaining({ mode: 'unit_price', base_unit_price: 70, units: 0, amount: 300 }),
		});
		expect(lineOp(plan, 'line-11-lic')!.values).toMatchObject({ quantity: 10, unit_price: 70, subtotal: 700 });
		expect(plan.preview.warnings[0].message).toContain('menor precio unitario');
	});

	it('moneda de contrato distinta a la de factura: el exceso y el ajuste van en moneda de contrato; la factura destino convierte con su tasa', () => {
		const plan = planChange(
			context({
				contract: contractRow({ contract_currency: 'USD', invoice_currency: 'CLP', fx_invoice_policy: 'fixed' }),
				items: [itemRow({ currency: 'USD' }), soporteRow({ currency: 'USD' })],
				invoices: MONTHS.map((mm) => invoiceRow(mm, { contract_currency: 'USD', invoice_currency: 'CLP', fx: 900 })),
			}),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 7, unit_price: 100 }], ...COMPENSATE },
				{ effective_date: '2026-09-01' }
			)
		);

		expect(plan.preview.issued_compensation![0]).toMatchObject({ currency: 'USD', amount: 300 });
		expect(lineOp(plan, 'line-10-lic')!.values).toMatchObject({ quantity: 4, unit_price: 100, subtotal: 400 });
		expect(ops(plan, 'insert_invoice_adjustment')[0]).toMatchObject({ amount_diff: -300, notes: expect.stringContaining('USD 300,00') });
		// Total de octubre en moneda de factura con la tasa de esa factura: (400 + 200) × 1,19 × 900.
		expect(plan.preview.invoices.updated[0].detail?.invoice_currency_amounts).toEqual({ before: 1428, after: 642600 });
	});

	it('destino dentro de una unificada: editable → se aplica al origen y pregunta por la unificada; con borrador en el ERP → bloquea', () => {
		const withUnified = (state: 'editable' | 'in_erp') =>
			downsell('2026-09-01', 7, COMPENSATE, {
				invoices: MONTHS.map((mm) =>
					mm === '10'
						? invoiceRow(mm, { is_active: false, consolidated_into_invoice_id: 'uni-1', unified_state: state, unified_number: 'U-1' })
						: invoiceRow(mm)
				),
			});
		const editable = withUnified('editable');

		expect(editable.preview.blockers).toEqual([]);
		expect(codes(editable.preview.warnings)).toContain('unified_resync');
		expect(lineOp(editable, 'line-10-lic')!.values).toMatchObject({ quantity: 4, subtotal: 400 });
		expect(codes(withUnified('in_erp').preview.blockers)).toContain('unified_invoice_in_erp');
	});

	it('emitida dentro de una unificada: su origen cuenta como emitido (se mide, no bloquea)', () => {
		const plan = downsell('2026-09-01', 7, COMPENSATE, {
			invoices: MONTHS.map((mm) =>
				mm === '09'
					? invoiceRow(mm, {
							status: 'Por Emitir',
							invoice_number: null,
							is_active: false,
							consolidated_into_invoice_id: 'uni-0',
							unified_state: 'issued',
							unified_number: 'U-9',
						})
					: invoiceRow(mm)
			),
		});

		expect(plan.preview.blockers).toEqual([]);
		expect(plan.preview.issued_compensation![0]).toMatchObject({ amount: 300 });
		expect(plan.ops.some((op) => 'invoice_id' in op && op.invoice_id === 'inv-09')).toBe(false);
	});

	it('ítem por consumo: lo emitido con consumo registrado no se compensa solo (bloquea con el siguiente paso)', () => {
		const plan = downsell('2026-09-01', 7, COMPENSATE, { invoices: invoices((mm) => (mm === '09' ? { quantity_source: 'consumption' } : {})) });

		expect(plan.preview.blockers).toEqual([
			expect.objectContaining({ code: 'compensation_not_supported', next_step: 'Lo emitido de este producto se corrige con nota de crédito' }),
		]);
		expect(plan.preview.issued_compensation).toBeUndefined();
	});

	it('fecha a mitad de un período emitido: el exceso de ese período se prorratea por días', () => {
		const plan = downsell('2026-09-16', 7, COMPENSATE);

		// Septiembre: 15 de 30 días con 3 licencias menos = 150.
		expect(ops(plan, 'insert_item')[0].item).toMatchObject({ categoria: 'DOWNSELL', start_date: '2026-09-16' });
		expect(plan.preview.issued_compensation![0].issued).toEqual([
			expect.objectContaining({
				invoice_number: 'F-09',
				period_start: '2026-09-16',
				period_end: '2026-09-30',
				issued: 1000,
				expected: 850,
				overcharge: 150,
			}),
		]);
		// 1,5 licencias-mes ya facturadas: octubre sale con 7 − 1,5 = 5,5 al mismo precio.
		expect(lineOp(plan, 'line-10-lic')!.values).toMatchObject({ quantity: 5.5, unit_price: 100, discount_pct: 0, subtotal: 550 });
		expect(compensationOf(lineOp(plan, 'line-10-lic')!.values.pricing_breakdown as never)?.label).toBe(
			'7 del período menos 1,5 ya facturados en sep 2026 (3 x 0,5)'
		);
	});

	it('saldo mayor que un período: la línea queda en 0 y el saldo pasa al período siguiente del mismo producto', () => {
		const plan = downsell('2026-07-01', 7, COMPENSATE);
		const [compensation] = plan.preview.issued_compensation!;

		expect(compensation.amount).toBe(900);
		expect(compensation.compensated.map((row) => [row.invoice_id, row.line_before, row.amount, row.line_after])).toEqual([
			['inv-10', 700, 700, 0],
			['inv-11', 700, 200, 500],
		]);
		// Octubre: lo ya facturado cubre el período completo, la línea queda en cantidad 0 (nunca negativa, sin descuento). Soporte no
		// recibe nada.
		expect(lineOp(plan, 'line-10-lic')!.values).toMatchObject({ quantity: 0, unit_price: 100, discount_pct: 0, subtotal: 0, total: 0 });
		expect(lineOp(plan, 'line-11-lic')!.values).toMatchObject({ quantity: 5, unit_price: 100, discount_pct: 0, subtotal: 500 });
		expect(lineOp(plan, 'line-12-lic')!.values).toMatchObject({ subtotal: 700 });
		expect(ops(plan, 'update_line').some((op) => String(op.line_id).endsWith('-sop'))).toBe(false);
		expect(codes(plan.preview.warnings)).toEqual(['compensation_line_zero', 'issued_overcharge_compensated']);
		expect(ops(plan, 'insert_invoice_adjustment').map((op) => [op.invoice_id, op.amount_diff])).toEqual([
			['inv-10', -700],
			['inv-11', -200],
		]);
	});

	it('se acaban los períodos del producto: bloquea con el saldo y el siguiente paso; no reparte a otros productos', () => {
		const plan = downsell('2026-02-01', 1, COMPENSATE);

		// 9 licencias menos × 100 × 8 meses (feb–sep) = 7.200; en octubre a diciembre caben 3 × 100.
		expect(plan.preview.can_apply).toBe(false);
		expect(plan.preview.blockers).toEqual([
			{
				code: 'compensation_exceeds_pending',
				message:
					'Lo cobrado de más por "Licencia" (CLP 7.200,00) no cabe en las facturas por emitir del producto: quedan CLP 6.900,00 sin compensar',
				next_step:
					'Corrige ese saldo con una nota de crédito sobre lo emitido, o renueva o extiende el contrato para tener períodos donde compensarlo',
			},
		]);
		expect(plan.preview.issued_compensation![0]).toMatchObject({ amount: 7200, pending_balance: 6900 });
		expect(ops(plan, 'update_line').some((op) => String(op.line_id).endsWith('-sop'))).toBe(false);
	});
});

describe('corregir una baja ya registrada (1 → 15) con lo emitido', () => {
	const RECORD = '44444444-4444-4444-8444-444444444444';
	/** Licencia 10 × 100 con una baja de 1 desde el 01-07: julio a septiembre emitidos con 9 y octubre a diciembre Por Emitir con 9. */
	const withRecord = (overrides: Partial<ChangeContext> = {}): ChangeContext =>
		context({
			items: [
				itemRow(),
				itemRow({
					id: RECORD,
					categoria: 'DOWNSELL',
					quantity: 1,
					unit_price: -100,
					annual_unit_price: -1200,
					monthly_price: -100,
					billing_period_price: -100,
					price: -600,
					final_price: -600,
					term_months: 6,
					start_date: '2026-07-01',
					related_item_id: LICENCIA,
					booking_date: '2026-07-02',
				}),
				soporteRow(),
			],
			invoices: invoices((mm) => (Number(mm) >= 7 ? { quantity: 9, subtotal: 900, tax_amount: 171, total: 1071 } : {})).map((invoice) =>
				Number(invoice.id.slice(-2)) >= 7 ? { ...invoice, subtotal: 1100, vat: 209 } : invoice
			),
			...overrides,
		});
	const correct = (quantity: number, change: Record<string, unknown> = {}, overrides: Partial<ChangeContext> = {}) =>
		planChange(withRecord(overrides), request({ type: 'item_update', items: [{ item_id: RECORD, quantity }], ...change }));

	it('sin el modo: bloquea con el monto cobrado de más y ofrece la opción', () => {
		const plan = correct(4);

		expect(plan.preview.blockers).toEqual([
			expect.objectContaining({
				code: 'issued_after_effective_date',
				message: expect.stringContaining('se cobraron de más CLP 900,00'),
				next_step: expect.stringContaining('compensar lo cobrado de más en las próximas facturas'),
			}),
		]);
		expect(plan.preview.issued_compensation_available).toBe(true);
	});

	it('con el modo: el mismo registro pasa a 4, el producto queda con 6 desde julio y las 9 licencias-mes facturadas de más se compensan', () => {
		const plan = correct(4, COMPENSATE);

		expect(plan.preview.blockers).toEqual([]);
		// Se corrige el mismo registro (no nace otra baja): cantidad, valor y mensual; inicio y booking intactos.
		expect(ops(plan, 'insert_item')).toEqual([]);
		expect(ops(plan, 'update_item')).toEqual([
			{
				kind: 'update_item',
				item_id: RECORD,
				set: { quantity: 4, price: -2400, final_price: -2400, annual_price: -4800, monthly_price: -400, billing_period_price: -400 },
			},
		]);
		expect(plan.preview.contract).toMatchObject({ before: { mrr: 1100 }, after: { mrr: 800 } });
		expect(plan.preview.rsm).toMatchObject({ mrr_delta: -300, first_month: '2026-07-01' });
		expect(plan.preview.issued_compensation![0]).toMatchObject({ item_id: LICENCIA, amount: 900, pending_balance: 0 });
		expect(plan.preview.issued_compensation![0].issued.map((row) => [row.invoice_number, row.issued, row.expected, row.overcharge])).toEqual([
			['F-07', 900, 600, 300],
			['F-08', 900, 600, 300],
			['F-09', 900, 600, 300],
		]);
		// 3 de más × 3 meses = 9: octubre (6) queda en 0 y noviembre en 6 − 3 = 3; diciembre completo. Nunca con descuento.
		expect(lineOp(plan, 'line-10-lic')!.values).toMatchObject({ quantity: 0, unit_price: 100, discount_pct: 0, subtotal: 0 });
		expect(lineOp(plan, 'line-11-lic')!.values).toMatchObject({ quantity: 3, unit_price: 100, discount_pct: 0, subtotal: 300 });
		expect(lineOp(plan, 'line-12-lic')!.values).toMatchObject({ quantity: 6, unit_price: 100, subtotal: 600 });
		expect(plan.event).toMatchObject({ type: 'ITEM_CORRECTED', subtype: 'downsell_quantity', items_affected: [RECORD, LICENCIA] });
		expect(plan.event.description).toBe(
			'"Licencia": cantidad dada de baja 1 → 4 · lo cobrado de más en lo ya emitido (CLP 900,00) se compensa en las próximas facturas del mismo producto'
		);
		expect(plan.event.metadata).toMatchObject({
			items: [{ item_id: RECORD, changes: [{ field: 'quantity', before: 1, after: 4 }] }],
			related_item_id: LICENCIA,
			downsell_start: '2026-07-01',
			issued_overcharge: 'compensate_next',
		});
		expect(plan.preview.items_after).toEqual([
			expect.objectContaining({ item_id: RECORD, changes: [{ field: 'quantity', before: 1, after: 4 }] }),
		]);
	});

	it('el saldo sigue en las facturas de la renovación del mismo producto antes de bloquear', () => {
		const RENEWAL = '33333333-3333-4333-8333-333333333333';
		const january = invoiceRow('01');
		const base = withRecord();
		const plan = correct(4, COMPENSATE, {
			// La baja de 1 rige desde febrero: febrero a septiembre emitidos con 9; la renovación (9 × 100) ya tiene su factura de enero.
			items: [
				...base.items.map((item) =>
					item.id === LICENCIA
						? { ...item, renewed_by_item_id: RENEWAL }
						: item.id === RECORD
							? { ...item, start_date: '2026-02-01', term_months: 11, price: -1100, final_price: -1100 }
							: item
				),
				itemRow({
					id: RENEWAL,
					categoria: 'RENEWAL',
					quantity: 9,
					monthly_price: 900,
					start_date: '2027-01-01',
					end_date: '2027-12-31',
					renews_item_id: LICENCIA,
				}),
			],
			invoices: [
				...invoices((mm) => (Number(mm) >= 2 ? { quantity: 9, subtotal: 900, tax_amount: 171, total: 1071 } : {})).map((invoice) =>
					Number(invoice.id.slice(-2)) >= 2 ? { ...invoice, subtotal: 1100, vat: 209 } : invoice
				),
				{
					...january,
					id: 'inv-2027-01',
					invoice_number: null,
					status: 'Por Emitir',
					issue_date: '2027-01-01',
					subtotal: 900,
					vat: 171,
					lines: [
						{
							...january.lines[0],
							id: 'line-2027-01',
							invoice_id: 'inv-2027-01',
							contract_item_id: RENEWAL,
							quantity: 9,
							subtotal: 900,
							tax_amount: 171,
							total: 1071,
							billing_period_start: '2027-01-01',
							billing_period_end: '2027-01-31',
						},
					],
				},
			],
		});
		const [compensation] = plan.preview.issued_compensation!;

		// 3 × 100 × 8 meses = 2.400: octubre, noviembre y diciembre (600 c/u) y 600 en enero de la renovación.
		expect(plan.preview.blockers).toEqual([]);
		expect(compensation.compensated.map((row) => [row.invoice_id, row.amount, row.line_after])).toEqual([
			['inv-10', 600, 0],
			['inv-11', 600, 0],
			['inv-12', 600, 0],
			['inv-2027-01', 600, 300],
		]);
		expect(lineOp(plan, 'line-2027-01')!.values).toMatchObject({ quantity: 3, unit_price: 100, discount_pct: 0, subtotal: 300 });
	});

	it('sin facturas emitidas desde la baja no hay nada que compensar: se corrige sin pedir el modo', () => {
		const plan = correct(
			4,
			{},
			{
				invoices: withRecord().invoices.map((invoice) =>
					Number(invoice.id.slice(-2)) >= 7 ? { ...invoice, status: 'Por Emitir', invoice_number: null } : invoice
				),
			}
		);

		expect(plan.preview.blockers).toEqual([]);
		expect(plan.preview.issued_compensation).toBeUndefined();
		expect(lineOp(plan, 'line-07-lic')!.values).toMatchObject({ quantity: 6, subtotal: 600 });
	});

	it('baja corregida a menos con facturas emitidas: lo emitido cobró de menos y se registra como aumento', () => {
		const plan = planChange(
			withRecord({
				items: withRecord().items.map((item) =>
					item.id === RECORD ? { ...item, quantity: 4, monthly_price: -400, price: -2400, final_price: -2400 } : item
				),
			}),
			request({ type: 'item_update', items: [{ item_id: RECORD, quantity: 1 }], ...COMPENSATE })
		);

		expect(plan.preview.blockers).toEqual([
			expect.objectContaining({ code: 'issued_undercharge', next_step: expect.stringContaining('Cambió el precio o la cantidad') }),
		]);
	});

	it('validaciones: solo la cantidad, una rebaja de precio no se corrige así y el producto no puede quedar sin unidades', () => {
		const errors = (items: Array<Record<string, unknown>>, overrides: Partial<ChangeContext> = {}) => {
			try {
				planChange(withRecord(overrides), request({ type: 'item_update', items }));
			} catch (error) {
				return ((error as { getResponse: () => { errors: Array<{ field: string; message: string }> } }).getResponse().errors ?? []).map(
					(entry) => entry.message
				);
			}

			return [];
		};

		expect(errors([{ item_id: RECORD, quantity: 4, account: 'Otra' }])).toEqual([
			'En el registro de una baja solo se corrige la cantidad que se dio de baja',
		]);
		expect(errors([{ item_id: RECORD, quantity: 1 }])).toEqual(['La baja de "Licencia" ya tiene esa cantidad: no hay nada que corregir']);
		expect(errors([{ item_id: RECORD, quantity: 10 }])).toEqual([
			'Con 10 de baja "Licencia" queda sin unidades: para quitar el producto usa la baja del producto',
		]);
		expect(
			errors([{ item_id: RECORD, quantity: 4 }], {
				items: withRecord().items.map((item) => (item.id === RECORD ? { ...item, quantity: 10, unit_price: -10 } : item)),
			})
		).toEqual([expect.stringContaining('es una rebaja de precio, no de cantidad')]);
		// El precio de un registro de baja sigue sin corregirse (regla de siempre).
		expect(errors([{ item_id: RECORD, unit_price: 50 }])).toEqual(['"Licencia" es el registro de una baja: su valor no se corrige']);
	});
});

describe('caso real S07212 (SimpliRoute México, MXN): baja de 1 licencia registrada el 02-09 que eran 15', () => {
	const PATHFINDER = '4b4d3613-3a38-4f26-9561-6619b3fa3349';
	const DOWNSELL = 'bb19ec2e-8402-4017-8911-d05160e62dcb';
	const REPORTE = 'fd3dcdf4-5b4f-484f-87c4-d3a18d83b437';
	const MODULO = '0ce0ec85-7d28-4e3e-9cfc-a4b27ccbcba1';
	const DECEMBER = '9d9a141c-6b58-4f6b-aaa4-f6c3d3bf71a4';
	const line = (invoiceId: string, itemId: string, start: string, end: string, quantity: number, unit: number, pct = 0): ChangeInvoiceLineRow => {
		const subtotal = Math.round(quantity * unit * (1 - pct / 100) * 100) / 100;
		const tax = Math.round(subtotal * 16) / 100;

		return {
			id: `${invoiceId}-${itemId.slice(0, 4)}`,
			invoice_id: invoiceId,
			contract_item_id: itemId,
			product_id: null,
			description: null,
			quantity,
			unit_price: unit,
			unit_price_invoice: unit,
			discount_pct: pct,
			subtotal,
			subtotal_invoice: subtotal,
			tax_amount: tax,
			tax_amount_invoice: tax,
			total: subtotal + tax,
			total_invoice: subtotal + tax,
			billing_period_start: start,
			billing_period_end: end,
			unit_of_measure: null,
		};
	};
	const invoice = (id: string, number: string | null, status: string, start: string, end: string, licences: number): ChangeInvoiceRow => {
		const lines = [
			line(id, PATHFINDER, start, end, licences, 627),
			line(id, REPORTE, start, end, 1, 3800),
			line(id, MODULO, start, end, 1, 6000, 25),
		];
		const subtotal = lines.reduce((sum, row) => sum + row.subtotal, 0);

		return {
			...invoiceRow('01'),
			id,
			invoice_number: number,
			status,
			issue_date: start,
			due_date: end,
			contract_currency: 'MXN',
			invoice_currency: 'MXN',
			tax_rate: 16,
			subtotal,
			vat: Math.round(subtotal * 16) / 100,
			amount_invoice: subtotal,
			total_invoice: Math.round(subtotal * 116) / 100,
			lines,
		};
	};
	const item = (id: string, name: string, quantity: number, unit: number, overrides: Parameters<typeof itemRow>[0] = {}) =>
		itemRow({
			id,
			product_id: null,
			product_name: name,
			categoria: 'RENEWAL',
			unit_of_measure: null,
			quantity,
			unit_price: unit,
			annual_unit_price: unit * 12,
			monthly_price: quantity * unit,
			billing_period_price: quantity * unit,
			price: quantity * unit * 5,
			final_price: quantity * unit * 5,
			term_months: 5,
			start_date: '2026-08-01',
			end_date: '2026-12-31',
			booking_date: '2026-08-01',
			currency: 'MXN',
			...overrides,
		});
	const s07212 = (): ChangeContext =>
		context({
			contract: contractRow({
				contract_number: 'S07212',
				contract_currency: 'MXN',
				invoice_currency: 'MXN',
				system_currency: 'USD',
				company_currency: 'MXN',
				auto_invoice: true,
				company: {
					legal_name: 'SimpliRoute S.A.P.I DE C.V',
					tax_id: 'SIM000000XXX',
					address: null,
					country: 'Mexico',
					tax_rate: '16',
					currency: 'MXN',
				},
			}),
			items: [
				item(PATHFINDER, 'PATHFINDER+', 76, 627),
				item(DOWNSELL, 'PATHFINDER+', 1, -627, {
					categoria: 'DOWNSELL',
					monthly_price: -627,
					billing_period_price: -627,
					price: -2508,
					final_price: -2508,
					term_months: 4,
					start_date: '2026-09-01',
					booking_date: '2026-09-02',
					related_item_id: PATHFINDER,
					discount_type: 'Porcentaje',
					discount_value: 0,
				}),
				item(REPORTE, 'Reporte', 1, 3800),
				item(MODULO, 'MODULO', 1, 6000, {
					discount_type: 'Porcentaje',
					discount_value: 25,
					monthly_price: 4500,
					price: 22500,
					final_price: 22500,
				}),
			],
			invoices: [
				invoice('dc0c884a', 'A9834', 'Pagada', '2026-08-01', '2026-08-31', 76),
				invoice('c03c91d2', 'A9986', 'Vencida', '2026-09-01', '2026-09-30', 75),
				invoice('a2e7dfc5', 'A10089', 'Vencida', '2026-10-01', '2026-10-31', 75),
				invoice('9bf577a6', 'A10185', 'Emitida', '2026-11-01', '2026-11-30', 75),
				invoice(DECEMBER, null, 'Por Emitir', '2026-12-01', '2026-12-31', 75),
			],
			today: '2026-11-16',
		});

	it('queda en 61 licencias desde el 01-09; las 42 ya facturadas de más se compensan en diciembre: 19 × 627 = 11.913 y factura 20.213 más IVA', () => {
		const plan = planChange(
			s07212(),
			request({ type: 'item_update', items: [{ item_id: DOWNSELL, quantity: 15 }], ...COMPENSATE }, { effective_date: '2026-11-16' })
		);

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'update_item')[0]).toMatchObject({
			item_id: DOWNSELL,
			set: { quantity: 15, final_price: -37620, monthly_price: -9405 },
		});
		// MRR esperado: 61 × 627 + 3.800 + 4.500 = 46.547.
		expect(plan.preview.contract.after.mrr).toBe(46547);
		expect(plan.preview.rsm.first_month).toBe('2026-09-01');
		const [compensation] = plan.preview.issued_compensation!;

		expect(compensation).toMatchObject({ item_id: PATHFINDER, currency: 'MXN', mode: 'quantity', amount: 26334, pending_balance: 0 });
		expect(compensation.issued.map((row) => [row.invoice_number, row.issued, row.expected, row.overcharge])).toEqual([
			['A9986', 47025, 38247, 8778],
			['A10089', 47025, 38247, 8778],
			['A10185', 47025, 38247, 8778],
		]);
		expect(compensation.compensated).toEqual([
			expect.objectContaining({
				invoice_id: DECEMBER,
				line_before: 38247,
				amount: 26334,
				line_after: 11913,
				quantity_before: 61,
				quantity_after: 19,
				unit_price_before: 627,
				unit_price_after: 627,
			}),
		]);
		const december = lineOp(plan, `${DECEMBER}-4b4d`)!.values;

		// Sin descuento y al mismo precio: 61 del período − 14 × 3 ya facturadas = 19 licencias × 627.
		expect(december).toMatchObject({
			quantity: 19,
			unit_price: 627,
			discount_pct: 0,
			subtotal: 11913,
			tax_amount: 1906.08,
			total: 13819.08,
		});
		expect(compensationOf(december.pricing_breakdown as never)).toMatchObject({
			kind: 'compensation',
			amount: 0,
			label: '61 del período menos 42 ya facturados en sep-nov 2026 (14 x 3)',
			compensation: expect.objectContaining({ mode: 'quantity', base_quantity: 61, base_unit_price: 627, units: 42, amount: 26334 }),
		});
		expect(december.description).toContain('61 del periodo menos 42 ya facturados en sep-nov 2026 (14 x 3)');
		// La factura que compensa más las ya emitidas suman el total con el ajuste: 3 × 75 × 627 + 19 × 627 = 4 meses × 61 × 627.
		expect(3 * 47025 + Number(december.subtotal)).toBe(4 * 61 * 627);
		expect(plan.preview.invoices.updated).toEqual([expect.objectContaining({ id: DECEMBER, subtotal_before: 55325, subtotal_after: 20213 })]);
		expect(plan.preview.invoices.updated[0].detail?.after).toEqual({ subtotal: 20213, tax: 3234.08, total: 23447.08 });
		expect(ops(plan, 'insert_invoice_adjustment')).toEqual([
			expect.objectContaining({ invoice_id: DECEMBER, type: 'downsell', amount_diff: -26334 }),
		]);
		// Ninguna emitida recibe operaciones ni nota de crédito.
		expect(plan.preview.invoices.credit_notes).toEqual([]);
		expect(plan.ops.filter((op) => 'invoice_id' in op).every((op) => (op as { invoice_id: string }).invoice_id === DECEMBER)).toBe(true);
	});
});

describe('la línea compensada no se pisa en silencio', () => {
	const RECORD = '55555555-5555-4555-8555-555555555555';
	/** Tras una baja 10 → 7 desde el 01-09 con compensación: octubre lleva 7 − 3 ya facturadas = 4 × 100 (neto 400), sin descuento. */
	const compensated = (): ChangeContext =>
		context({
			items: [
				itemRow(),
				itemRow({
					id: RECORD,
					categoria: 'DOWNSELL',
					quantity: 3,
					unit_price: -100,
					annual_unit_price: -1200,
					monthly_price: -300,
					billing_period_price: -300,
					price: -1200,
					final_price: -1200,
					term_months: 4,
					start_date: '2026-09-01',
					related_item_id: LICENCIA,
				}),
				soporteRow(),
			],
			invoices: invoices((mm) =>
				mm === '10'
					? {
							quantity: 4,
							subtotal: 400,
							tax_amount: 76,
							total: 476,
							pricing_breakdown: [
								compensationMarker({
									item_id: LICENCIA,
									periods: [
										{
											invoice_id: 'inv-09',
											invoice_number: 'F-09',
											period_start: '2026-09-01',
											period_end: '2026-09-30',
											amount: 300,
										},
									],
									mode: 'quantity',
									count: { quantity: 3, months: 1 },
									base_quantity: 7,
									base_unit_price: 100,
									units: 3,
									amount: 300,
								}),
							],
						}
					: Number(mm) > 10
						? { quantity: 7, subtotal: 700, tax_amount: 133, total: 833 }
						: {}
			).map((invoice) => (invoice.id === 'inv-10' ? { ...invoice, subtotal: 600, vat: 114 } : invoice)),
		});
	const change = (items: Array<Record<string, unknown>>, effective: string, type = 'item_change') =>
		planChange(compensated(), request({ type, items } as never, { effective_date: effective }));

	it('otro cambio que reescribe la línea vuelve a aplicar el ajuste sobre el valor nuevo', () => {
		const plan = change([{ item_id: LICENCIA, quantity: 5, unit_price: 100 }], '2026-10-01');
		const october = lineOp(plan, 'line-10-lic')!.values;

		// El producto baja a 5: octubre queda en 5 − 3 ya facturadas = 2 × 100, sin descuento.
		expect(october).toMatchObject({ quantity: 2, unit_price: 100, subtotal: 200, discount_pct: 0 });
		expect(compensationOf(october.pricing_breakdown as never)).toMatchObject({
			label: '5 del período menos 3 ya facturados en sep 2026 (3 x 1)',
			compensation: { item_id: LICENCIA, base_quantity: 5, units: 3, amount: 300 },
		});
		expect(codes(plan.preview.warnings)).not.toContain('compensation_reduced');
		expect(plan.preview.invoices.updated[0]).toMatchObject({ id: 'inv-10', subtotal_before: 600, subtotal_after: 400 });
	});

	it('si el valor nuevo de la línea ya no alcanza, compensa lo que cabe y avisa el saldo que queda sin compensar', () => {
		const plan = change([{ item_id: LICENCIA, quantity: 2, unit_price: 100 }], '2026-10-01');
		const october = lineOp(plan, 'line-10-lic')!.values;

		expect(october).toMatchObject({ quantity: 0, unit_price: 100, subtotal: 0, discount_pct: 0 });
		expect(compensationOf(october.pricing_breakdown as never)).toMatchObject({ compensation: { base_quantity: 2, units: 2, amount: 200 } });
		expect(plan.preview.warnings).toContainEqual(
			expect.objectContaining({ code: 'compensation_reduced', message: expect.stringContaining('100,00 quedan sin compensar') })
		);
	});

	it('si el cambio quita la línea, avisa el saldo perdido', () => {
		const plan = change([{ item_id: SOPORTE }, { item_id: LICENCIA }], '2026-10-01', 'contract_cancel');

		expect(plan.preview.warnings).toContainEqual(
			expect.objectContaining({ code: 'compensation_lost', message: expect.stringContaining('compensaba 300,00') })
		);
	});

	it('un cambio que no toca la línea la deja exactamente como estaba', () => {
		const ctx = compensated();
		const plan = planChange(ctx, request({ type: 'item_update', items: [{ item_id: SOPORTE, account: 'Sucursal Norte' }] }));
		const october = ctx.invoices.find((invoice) => invoice.id === 'inv-10')!.lines.find((row) => row.id === 'line-10-lic')!;

		expect(lineOp(plan, 'line-10-lic')).toBeUndefined();
		expect(october).toMatchObject({ quantity: 4, unit_price: 100, subtotal: 400, discount_pct: 0, tax_amount: 76, total: 476 });
		expect(compensationOf(october.pricing_breakdown)).toMatchObject({ compensation: { base_quantity: 7, units: 3, amount: 300 } });
	});

	it('el descuento puntual comercial de una línea también sobrevive a una rebaja posterior (antes se pisaba)', () => {
		const plan = planChange(
			context({
				invoices: invoices((mm) =>
					mm === '11'
						? {
								discount_pct: 10,
								subtotal: 900,
								tax_amount: 171,
								total: 1071,
								pricing_breakdown: [
									{
										kind: 'discount' as const,
										one_off: true,
										amount: -100,
										label: 'Descuento puntual: cortesía',
										quantity: 1,
										one_off_type: 'pct',
										one_off_value: 10,
										base_discount_pct: 0,
									} as never,
								],
							}
						: {}
				),
			}),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 7, unit_price: 100 }] }, { effective_date: '2026-10-01' })
		);
		const november = lineOp(plan, 'line-11-lic')!.values;

		// 7 × 100 = 700 con el 10 % puntual = 630.
		expect(november).toMatchObject({ quantity: 7, unit_price: 100, subtotal: 630, discount_pct: 10 });
		expect(november.pricing_breakdown).toEqual([expect.objectContaining({ one_off: true, amount: -70, one_off_type: 'pct', one_off_value: 10 })]);
	});
});

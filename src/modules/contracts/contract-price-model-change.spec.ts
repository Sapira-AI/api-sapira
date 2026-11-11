import { BadRequestException } from '@nestjs/common';

import { planChange, PRICE_MODEL_CHANGE_CODES, type WriteOp } from './contract-changes';
import { context, invoiceRow, itemRow, LICENCIA, request, soporteRow } from './contract-changes.test-fixtures';
import { METERED_ADVANCE_MESSAGE } from './contract-drafts.service';

import type { PriceSpec } from './pricing-engine';

/**
 * `price_model_change` (Domi 05-10, spec-modificaciones-contrato-v2 §9.3.11): cambiar el modelo de precio de un ítem vigente. Fixture: Licencia
 * 10 × 100 mensual Anticipado (emitida hasta septiembre, Por Emitir octubre–diciembre).
 */
const TIERS: PriceSpec = {
	model: 'graduated',
	quantity_type: 'fixed',
	invoice_line_mode: 'per_tier',
	tiers: [
		{ from: 1, to: 5, per_unit_amount: 100, flat_amount: 0 },
		{ from: 6, to: null, per_unit_amount: 80, flat_amount: 0 },
	],
};
const change = (price: PriceSpec | null, extra: Record<string, unknown> = {}) => ({
	type: 'price_model_change' as const,
	items: [{ item_id: LICENCIA, price, ...extra }],
});
const ofKind = <K extends WriteOp['kind']>(ops: WriteOp[], kind: K) => ops.filter((op): op is Extract<WriteOp, { kind: K }> => op.kind === kind);
const fieldErrors = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(BadRequestException);

		return ((error as BadRequestException).getResponse() as { errors: Array<{ field: string; message: string }> }).errors;
	}
	throw new Error('se esperaba un 400');
};

describe('price_model_change (cambiar el modelo de precio de un ítem)', () => {
	it('estándar → tramos: corta el ítem el día antes, RENEWAL con el precio nuevo, MRR = el modelo a la cantidad base, Por Emitir regeneradas', () => {
		const plan = planChange(context(), request(change(TIERS), { effective_date: '2026-11-01' }));
		const [renewal] = ofKind(plan.ops, 'insert_item');

		expect(plan.preview.blockers).toEqual([]);
		// Tramos a la cantidad base 10: 5 × 100 + 5 × 80 = 900 (antes 1.000).
		expect(renewal.item).toMatchObject({
			categoria: 'RENEWAL',
			renews_item_id: LICENCIA,
			start_date: '2026-11-01',
			end_date: '2026-12-31',
			quantity: 10,
			unit_price: 90,
			final_price: 1800,
			price_spec: expect.objectContaining({ model: 'graduated', quantity_type: 'fixed', invoice_line_mode: 'per_tier' }),
			price_version: 1,
			supersedes_price_id: null,
			// El RSM separa el delta (DOWNSELL −100) con apply_renewal_price_split.
			renewal_base_unit_price: 100,
		});
		expect(ofKind(plan.ops, 'update_item')).toEqual([
			expect.objectContaining({
				item_id: LICENCIA,
				set: expect.objectContaining({ end_date: '2026-10-31', renewed_by_key: renewal.item.key }),
			}),
		]);
		// Noviembre y diciembre: las líneas del ítem se quitan y entran las del motor (una por tramo) en la misma Por Emitir.
		expect(ofKind(plan.ops, 'delete_line').map((op) => op.line_id)).toEqual(['line-11-lic', 'line-12-lic']);
		const [created] = ofKind(plan.ops, 'create_invoices');

		expect(created.merge_into).toEqual(['inv-11', 'inv-12']);
		expect(created.invoices[0].lines.map((line) => [line.quantity, line.subtotal])).toEqual([
			[5, 500],
			[5, 400],
		]);
		// Octubre (antes del corte) y lo emitido no se tocan.
		expect(ofKind(plan.ops, 'delete_line').some((op) => op.invoice_id === 'inv-10')).toBe(false);
		expect(plan.preview.rsm.mrr_delta).toBe(-100);
		expect(plan.event).toMatchObject({ type: 'DOWNSELL', subtype: 'price_model', amount_delta: -100, items_affected: [LICENCIA] });
		expect(plan.event.metadata).toMatchObject({
			price_model: { model_before: 'standard', model_after: 'graduated', monthly_before: 1000, monthly_after: 900, base_quantity: 10 },
		});
	});

	it('fecha a mitad de período: rige desde el próximo inicio de período, con aviso', () => {
		const plan = planChange(context(), request(change(TIERS), { effective_date: '2026-11-15' }));

		expect(ofKind(plan.ops, 'insert_item')[0].item.start_date).toBe('2026-12-01');
		expect(plan.preview.warnings.map((warning) => warning.code)).toContain('price_model_from_next_period');
	});

	it('cantidad base del pedido: el MRR es el modelo a esa cantidad (precio × cantidad → tramos sin cambiar el plan)', () => {
		const plan = planChange(context(), request(change(TIERS, { quantity: 12 }), { effective_date: '2026-11-01' }));

		// 5 × 100 + 7 × 80 = 1.060.
		expect(plan.event.amount_delta).toBe(60);
		expect(plan.event.type).toBe('UPSELL');
	});

	it('un período ya emitido después del corte bloquea (lo emitido se corrige con nota de crédito)', () => {
		const plan = planChange(context(), request(change(TIERS), { effective_date: '2026-09-01' }));

		expect(plan.preview.blockers.map((blocker) => blocker.code)).toContain('issued_after_effective_date');
	});

	it('por consumo: métrica obligatoria y activa, y el ítem debe facturarse vencido (salvo asiento)', () => {
		const metered: PriceSpec = { ...TIERS, quantity_type: 'metered', billable_metric_id: 'm-1' };
		const errors = fieldErrors(() =>
			planChange(context({ billable_metrics: new Map([['m-1', 'active']]) }), request(change(metered), { effective_date: '2026-11-01' }))
		);

		expect(errors).toEqual(expect.arrayContaining([{ field: 'change.items.0.billing_method', message: METERED_ADVANCE_MESSAGE }]));
		// Caso Ninja (07-10): el ítem vigente es Anticipado y el cambio lo pasa a Vencido → el RENEWAL nace Vencido.
		const toArrears = planChange(
			context({ billable_metrics: new Map([['m-1', 'active']]) }),
			request(change(metered, { billing_method: 'Vencido' }), { effective_date: '2026-11-01' })
		);

		expect(toArrears.preview.blockers).toEqual([]);
		expect(ofKind(toArrears.ops, 'insert_item')[0].item).toMatchObject({ billing_method: 'Vencido', start_date: '2026-11-01' });
		// Vencido: cada período se emite al cerrar (noviembre el 01-12, en la Por Emitir de diciembre; diciembre el 01-01).
		expect(
			ofKind(toArrears.ops, 'create_invoices')[0].invoices.map((invoice) => [invoice.issue_date, invoice.lines[0]?.billing_period_start])
		).toEqual([
			['2026-12-01', '2026-11-01'],
			['2027-01-01', '2026-12-01'],
		]);
		expect(toArrears.event.metadata).toMatchObject({ price_model: { billing_method_before: 'Anticipado', billing_method_after: 'Vencido' } });
		expect(
			fieldErrors(() => planChange(context(), request(change(TIERS, { billing_method: 'Mensual' }), { effective_date: '2026-11-01' })))
		).toEqual(expect.arrayContaining([{ field: 'change.items.0.billing_method', message: 'Modo de cobro inválido: Anticipado o Vencido' }]));
		const unknown = fieldErrors(() =>
			planChange(
				context({ items: [itemRow({ billing_method: 'Vencido' })], billable_metrics: new Map() }),
				request(change(metered), { effective_date: '2026-11-01' })
			)
		);

		expect(unknown.map((error) => error.field)).toContain('change.items.0.price.billable_metric_id');
	});

	it('pide el modelo nuevo, un ítem a la vez, y rechaza el mismo modelo que ya tiene', () => {
		expect(
			fieldErrors(() => planChange(context(), request(change(null), { effective_date: '2026-11-01' }))).map((error) => error.field)
		).toContain('change.items.0.price');
		const same = fieldErrors(() =>
			planChange(
				context({
					items: [
						itemRow({
							price_id: 'price-1',
							raw: {
								price_id: 'price-1',
								price_model: 'graduated',
								price_quantity_type: 'fixed',
								price_invoice_line_mode: 'per_tier',
								price_tiers: TIERS.tiers,
							},
						}),
					],
				}),
				request(change(TIERS), { effective_date: '2026-11-01' })
			)
		);

		expect(same).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'change.items.0.price' })]));
	});

	describe('solo el modo de cobro (Stanhome 10-11): `{ item_id, billing_method }` sin precio nuevo', () => {
		const method = (billing_method: string, extra: Record<string, unknown> = {}) => ({
			type: 'price_model_change' as const,
			items: [{ item_id: LICENCIA, billing_method, ...extra }],
		});
		const issueDates = (plan: ReturnType<typeof planChange>) =>
			ofKind(plan.ops, 'create_invoices')[0].invoices.map((invoice) => [invoice.issue_date, invoice.lines[0]?.billing_period_start]);

		it('Anticipado → Vencido con el período en curso sin emitir: RENEWAL con el mismo precio y la misma fila de prices, sin delta de MRR, y cada período sale al cerrarlo', () => {
			const plan = planChange(
				context({ items: [itemRow({ price_id: 'price-1' }), soporteRow()] }),
				request(method('Vencido'), { effective_date: '2026-11-01' })
			);
			const [renewal] = ofKind(plan.ops, 'insert_item');

			expect(plan.preview.blockers).toEqual([]);
			expect(renewal.item).toMatchObject({
				categoria: 'RENEWAL',
				renews_item_id: LICENCIA,
				start_date: '2026-11-01',
				end_date: '2026-12-31',
				billing_method: 'Vencido',
				quantity: 10,
				unit_price: 100,
				annual_unit_price: 1200,
				discount_type: null,
				discount_value: 0,
				final_price: 2000,
				price_id: 'price-1',
				reuse_price: true,
				price_version: null,
				supersedes_price_id: null,
				renewal_base_unit_price: null,
			});
			expect(ofKind(plan.ops, 'update_item')).toEqual([
				expect.objectContaining({
					item_id: LICENCIA,
					set: expect.objectContaining({ end_date: '2026-10-31', renewed_by_key: renewal.item.key }),
				}),
			]);
			// Octubre (anticipado, Por Emitir) no se toca; noviembre y diciembre se rehacen vencidos: salen el 01-12 y el 01-01.
			expect(ofKind(plan.ops, 'delete_line').map((op) => op.line_id)).toEqual(['line-11-lic', 'line-12-lic']);
			expect(issueDates(plan)).toEqual([
				['2026-12-01', '2026-11-01'],
				['2027-01-01', '2026-12-01'],
			]);
			expect(plan.preview.rsm.mrr_delta).toBe(0);
			expect(plan.event).toMatchObject({
				type: 'RENEWAL',
				subtype: 'billing_method',
				title: 'Cambio de modo de cobro',
				description: '"Licencia" pasa a cobro vencido desde el 2026-11-01',
				amount_delta: 0,
				items_affected: [LICENCIA],
			});
			expect(plan.event.metadata).toMatchObject({
				price_model: {
					billing_method_only: true,
					billing_method_before: 'Anticipado',
					billing_method_after: 'Vencido',
					monthly_before: 1000,
					monthly_after: 1000,
				},
			});
			const arrears = plan.preview.warnings.find((warning) => warning.code === 'billing_method_to_arrears');

			expect(arrears?.message).toBe(
				'"Licencia" pasa a cobro vencido: el período que comienza el 2026-11-01 se factura al cerrarlo (2026-12-01)'
			);
			expect(plan.preview.warnings.map((warning) => warning.code)).not.toContain('price_model_from_next_period');
			expect(plan.preview.warnings.map((warning) => warning.code)).not.toContain('fixed_discount_dropped');
		});

		it('Anticipado → Vencido con el período en curso ya emitido: ese período no se repite y el siguiente sale al cerrarlo', () => {
			// Corte el 01-10: septiembre está emitida (F-09) por adelantado; octubre en adelante salen vencidas (octubre el 01-11).
			const plan = planChange(context(), request(method('Vencido'), { effective_date: '2026-10-01' }));

			expect(plan.preview.blockers).toEqual([]);
			expect(ofKind(plan.ops, 'delete_line').map((op) => op.line_id)).toEqual(['line-10-lic', 'line-11-lic', 'line-12-lic']);
			expect(issueDates(plan)).toEqual([
				['2026-11-01', '2026-10-01'],
				['2026-12-01', '2026-11-01'],
				['2027-01-01', '2026-12-01'],
			]);
			expect(plan.preview.warnings.find((warning) => warning.code === 'billing_method_to_arrears')?.message).toBe(
				'"Licencia" pasa a cobro vencido: el período que comienza el 2026-10-01 se factura al cerrarlo (2026-11-01); el período ya facturado por adelantado no se repite'
			);
			// Un período emitido después del corte sigue bloqueando (lo emitido se corrige con nota de crédito).
			expect(
				planChange(context(), request(method('Vencido'), { effective_date: '2026-09-01' })).preview.blockers.map((blocker) => blocker.code)
			).toContain('issued_after_effective_date');
		});

		it('fecha a mitad de período: el cobro nuevo rige desde el próximo inicio de período, con aviso en palabras de cobro', () => {
			const plan = planChange(context(), request(method('Vencido'), { effective_date: '2026-11-15' }));

			expect(ofKind(plan.ops, 'insert_item')[0].item.start_date).toBe('2026-12-01');
			expect(plan.preview.warnings.find((warning) => warning.code === 'price_model_from_next_period')?.message).toBe(
				'El cobro vencido de "Licencia" rige desde el próximo inicio de período (2026-12-01): el período en curso sigue anticipado'
			);
		});

		it('Vencido → Anticipado: el día del corte salen dos facturas (la del período vencido y la del que comienza), avisado', () => {
			const arrearsItems = [itemRow({ billing_method: 'Vencido' }), soporteRow()];
			const plan = planChange(context({ items: arrearsItems }), request(method('Anticipado'), { effective_date: '2026-11-01' }));
			const [renewal] = ofKind(plan.ops, 'insert_item');

			expect(plan.preview.blockers).toEqual([]);
			expect(renewal.item).toMatchObject({
				billing_method: 'Anticipado',
				start_date: '2026-11-01',
				final_price: 2000,
				renewal_base_unit_price: null,
			});
			expect(issueDates(plan)).toEqual([
				['2026-11-01', '2026-11-01'],
				['2026-12-01', '2026-12-01'],
			]);
			expect(plan.preview.warnings.find((warning) => warning.code === 'two_invoices_in_transition')?.message).toBe(
				'"Licencia" pasa a cobro anticipado desde el 2026-11-01: ese día salen dos facturas, la del período vencido (2026-10-01 a 2026-10-31) y la del período que comienza'
			);
			expect(plan.event).toMatchObject({
				type: 'RENEWAL',
				subtype: 'billing_method',
				description: '"Licencia" pasa a cobro anticipado desde el 2026-11-01',
			});
			// Con el período anterior ya emitido no hay dos facturas el mismo día: sin aviso.
			const issuedBefore = planChange(context({ items: arrearsItems }), request(method('Anticipado'), { effective_date: '2026-10-01' }));

			expect(issuedBefore.preview.warnings.map((warning) => warning.code)).not.toContain('two_invoices_in_transition');
		});

		it('conserva el descuento en monto fijo y el precio anual del ítem (no es un modelo nuevo)', () => {
			const plan = planChange(
				context({
					items: [
						itemRow({ discount_type: 'Monto fijo', discount_value: 50, price_entry_mode: 'annual', annual_unit_price: 1200 }),
						soporteRow(),
					],
				}),
				request(method('Vencido'), { effective_date: '2026-11-01' })
			);

			expect(ofKind(plan.ops, 'insert_item')[0].item).toMatchObject({
				discount_type: 'Monto fijo',
				discount_value: 50,
				price_entry_mode: 'annual',
				annual_unit_price: 1200,
				unit_price: null,
			});
			expect(plan.preview.warnings.map((warning) => warning.code)).not.toContain('fixed_discount_dropped');
		});

		it('rechaza el mismo modo de cobro, y Anticipado en un ítem por consumo (salvo asiento) sin pedir la métrica de nuevo', () => {
			expect(fieldErrors(() => planChange(context(), request(method('Anticipado'), { effective_date: '2026-11-01' })))).toEqual(
				expect.arrayContaining([
					{ field: 'change.items.0.billing_method', message: '"Licencia" ya se cobra anticipado: elige el otro modo de cobro' },
				])
			);
			const metered = itemRow({
				billing_method: 'Vencido',
				price_id: 'price-1',
				raw: {
					price_id: 'price-1',
					price_model: 'standard',
					price_quantity_type: 'metered',
					price_billable_metric_id: 'm-1',
					price_unit_amount: 100,
				},
			});
			const errors = fieldErrors(() =>
				planChange(context({ items: [metered, soporteRow()] }), request(method('Anticipado'), { effective_date: '2026-11-01' }))
			);

			expect(errors).toEqual([{ field: 'change.items.0.billing_method', message: METERED_ADVANCE_MESSAGE }]);
			// El mismo modelo que ya tiene, pero con otro modo de cobro, es un cambio de modo de cobro (no `price_model_unchanged`).
			const fixed = itemRow({
				price_id: 'price-1',
				raw: { price_id: 'price-1', price_model: 'standard', price_quantity_type: 'fixed', price_unit_amount: 100 },
			});
			const sameSpec = planChange(
				context({ items: [fixed, soporteRow()] }),
				request(
					{
						type: 'price_model_change',
						items: [
							{ item_id: LICENCIA, price: { model: 'standard', quantity_type: 'fixed', unit_amount: 100 }, billing_method: 'Vencido' },
						],
					},
					{ effective_date: '2026-11-01' }
				)
			);

			expect(sameSpec.preview.blockers).toEqual([]);
			expect(ofKind(sameSpec.ops, 'insert_item')[0].item).toMatchObject({
				billing_method: 'Vencido',
				price_id: 'price-1',
				reuse_price: true,
				price_version: null,
			});
			expect(sameSpec.event.subtype).toBe('billing_method');
		});
	});

	it('con precio propio anterior: el nuevo es la versión siguiente y lo reemplaza (supersedes_price_id)', () => {
		const plan = planChange(
			context({
				items: [
					itemRow({
						price_id: 'price-1',
						raw: { price_id: 'price-1', price_version: 2, price_model: 'standard', price_quantity_type: 'fixed', price_unit_amount: 100 },
					}),
				],
			}),
			request(change(TIERS), { effective_date: '2026-11-01' })
		);

		expect(ofKind(plan.ops, 'insert_item')[0].item).toMatchObject({ price_version: 3, supersedes_price_id: 'price-1' });
	});

	describe('consumos registrados desde el corte', () => {
		const withConsumption = () =>
			context({
				items: [itemRow({ billing_method: 'Vencido' })],
				billable_metrics: new Map([['m-1', 'active']]),
				invoices: ['10', '11', '12'].map((mm) => {
					const invoice = invoiceRow(mm);

					if (mm === '11')
						invoice.lines[0] = {
							...invoice.lines[0],
							quantity: 14,
							subtotal: 1400,
							quantity_source: 'consumption',
							consumption: { quantity: 14, amount_override: null, apply_item_discount: true, is_estimated: false },
						};

					return invoice;
				}),
			});

		it('modelo por consumo: los consumos pasan al RENEWAL y el período se tarifa por tramo con la cantidad registrada', () => {
			const metered: PriceSpec = { ...TIERS, quantity_type: 'metered', billable_metric_id: 'm-1' };
			const plan = planChange(withConsumption(), request(change(metered), { effective_date: '2026-11-01' }));
			const [renewal] = ofKind(plan.ops, 'insert_item');

			expect(plan.preview.blockers).toEqual([]);
			expect(renewal.item.consumption).toEqual([expect.objectContaining({ period_start: '2026-11-01', quantity: 14 })]);
			expect(ofKind(plan.ops, 'move_consumption')).toEqual([
				{ kind: 'move_consumption', from_item_id: LICENCIA, to_key: renewal.item.key, from_period: '2026-11-01' },
			]);
			const november = ofKind(plan.ops, 'create_invoices')[0].invoices.find((invoice) => invoice.billing_period_start === '2026-11-01')!;

			// 14 rutas: 5 × 100 + 9 × 80 = 1.220.
			expect(november.lines.reduce((sum, line) => sum + line.subtotal, 0)).toBe(1220);
			expect(plan.preview.warnings.map((warning) => warning.code)).toContain('consumption_quantity_kept');
		});

		it('modelo de cantidad fija con correcciones de cantidad después del corte: bloquea', () => {
			const plan = planChange(withConsumption(), request(change(TIERS), { effective_date: '2026-11-01' }));

			expect(plan.preview.blockers.map((blocker) => blocker.code)).toContain(PRICE_MODEL_CHANGE_CODES.corrections_on_fixed);
		});
	});
});

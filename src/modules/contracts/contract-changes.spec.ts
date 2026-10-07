import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { CATALOG_PRICE_MESSAGES, type CatalogPrice } from './catalog-prices';
import { type ChangePlan, monthsCeil, planChange, taxRateFor, telescopicShares, unifiedDelta, wholeMonths } from './contract-changes';
import {
	context,
	CONTRACT_ID,
	contractRow,
	ENTITY_NEW,
	invoiceRow,
	itemRow,
	LICENCIA,
	PRODUCT_LICENCIA,
	PRODUCT_NUEVO,
	request,
	SOPORTE,
	soporteRow,
} from './contract-changes.test-fixtures';
import { taxRateForDocument } from './invoice-edit';

import type { PreviewLine } from './billing-engine';
import type { PricedSubline } from './pricing-engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const inserted = (plan: ChangePlan) => ops(plan, 'insert_item').map((op) => (op as { item: Record<string, unknown> }).item);
const fields = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(BadRequestException);

		return fieldErrorsOf(error)!.map((entry) => entry.field);
	}
	throw new Error('se esperaba un 400');
};

describe('fórmula unificada del delta (manual §8)', () => {
	it('STG-38: 160 × 13,68 → 140 × 16 es UPSELL +51,20 con qty −20 y unit −2,56 (qty × unit = ΔMRR)', () => {
		const delta = unifiedDelta({ current_quantity: 160, current_mrr: 2188.8, new_quantity: 140, new_unit_price: 16, discount_pct: 0 })!;

		expect(delta).toMatchObject({ categoria: 'UPSELL', mrr_delta: 51.2, quantity: -20, unit_price: -2.56 });
		expect(Math.round(delta.quantity * delta.unit_price * 100) / 100).toBe(51.2);
	});
	it('cruzado 100 × 10 → 120 × 7 es DOWNSELL −160 con qty −20 y unit 8; solo precio ancla la cantidad; sin cambio → null', () => {
		expect(unifiedDelta({ current_quantity: 100, current_mrr: 1000, new_quantity: 120, new_unit_price: 7, discount_pct: 0 })).toMatchObject({
			categoria: 'DOWNSELL',
			mrr_delta: -160,
			quantity: -20,
			unit_price: 8,
		});
		expect(unifiedDelta({ current_quantity: 1, current_mrr: 100, new_quantity: 1, new_unit_price: 120, discount_pct: 0 })).toMatchObject({
			quantity: 1,
			unit_price: 20,
		});
		// Descuento preservado (DPR 160 → 128 con 20 %): 1.000 → 800 con 20 % da 160 → 128.
		expect(unifiedDelta({ current_quantity: 1, current_mrr: 800, new_quantity: 1, new_unit_price: 800, discount_pct: 20 })).toMatchObject({
			mrr_delta: -160,
		});
		expect(unifiedDelta({ current_quantity: 10, current_mrr: 1000, new_quantity: 10, new_unit_price: 100, discount_pct: 0 })).toBeNull();
	});
	it('meses enteros y techo de meses', () => {
		expect(monthsCeil('2026-11-15', '2026-12-31')).toBe(2);
		expect(monthsCeil('2027-01-01', '2027-12-31')).toBe(12);
		expect(wholeMonths('2027-01-01', '2027-12-31')).toBe(12);
		expect(wholeMonths('2027-01-01', '2027-12-15')).toBeNull();
	});
});

describe('item_remove (M2)', () => {
	it('early: espejo DOWNSELL desde la fecha efectiva (U5), churn_date en la base, PE del mes prorrateada y las siguientes sin la línea', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }));
		const [mirror] = inserted(plan);

		// qty × unit = ΔMRR: 10 × −100 = −1.000; término 2 meses (15-11 → 31-12), final −2.000. DOWNSELL porque Soporte sigue.
		expect(mirror).toMatchObject({
			categoria: 'DOWNSELL',
			quantity: 10,
			unit_price: -100,
			final_price: -2000,
			term_months: 2,
			start_date: '2026-11-15',
			end_date: '2026-12-31',
			related_item_id: LICENCIA,
			// D-CTR-4: la baja se registra hoy (booking) aunque rija desde la fecha efectiva (start_date): el CMRR la anticipa.
			booking_date: '2026-09-28',
		});
		expect(ops(plan, 'update_item')).toEqual([
			{ kind: 'update_item', item_id: LICENCIA, set: { churn_date: '2026-11-15', churn_monthly_amount: 1000 } },
		]);
		// Noviembre: 14 de 30 días servidos → 466,67 + IVA 88,67; fin del período 14-11. Diciembre: línea quitada; Soporte intacto.
		const [november] = ops(plan, 'update_line') as Array<{ line_id: string; values: Record<string, unknown> }>;

		expect(november.line_id).toBe('line-11-lic');
		expect(november.values).toMatchObject({ subtotal: 466.67, tax_amount: 88.67, total: 555.34, billing_period_end: '2026-11-14', quantity: 10 });
		expect(ops(plan, 'delete_line')).toEqual([{ kind: 'delete_line', invoice_id: 'inv-12', line_id: 'line-12-lic' }]);
		expect(ops(plan, 'recompute_header').map((op) => (op as { invoice_id: string }).invoice_id)).toEqual(['inv-11', 'inv-12']);
		expect(plan.preview.invoices.updated).toEqual([
			expect.objectContaining({ id: 'inv-11', subtotal_before: 1200, subtotal_after: 666.67, lines_changed: 1 }),
			expect.objectContaining({ id: 'inv-12', subtotal_before: 1200, subtotal_after: 200, lines_changed: 1 }),
		]);
		expect(plan.preview.invoices.cancelled).toEqual([]);
		expect(plan.preview.invoices.credit_notes).toEqual([]);
		// Nunca toca emitidas: ninguna op apunta a inv-01…inv-09.
		expect(plan.ops.some((op) => 'invoice_id' in op && /inv-0\d/.test(String(op.invoice_id)))).toBe(false);
		// MRR a la fecha efectiva: 1.200 → 200 (la base churneada y su espejo salen del ítem madre).
		expect(plan.preview.contract).toMatchObject({
			before: { mrr: 1200, status: 'active' },
			after: { mrr: 200, status: 'active', end_date: '2026-12-31' },
		});
		expect(plan.preview.items.groups_after.map((group) => [group.product_name, group.mrr])).toEqual([['Soporte', 200]]);
		expect(plan.preview.items.ended).toEqual([{ item_id: LICENCIA, churn_date: '2026-11-15', timing: 'early' }]);
		expect(plan.preview.rsm).toMatchObject({ mrr_delta: -1000, momentum: 'DOWNSELL', first_month: '2026-11-01' });
		expect(plan.event).toMatchObject({
			type: 'DOWNSELL',
			subtype: 'early',
			amount_delta: -1000,
			items_affected: [LICENCIA],
			rsm_from_month: '2026-11-01',
		});
		expect(plan.preview.can_apply).toBe(true);
		expect(plan.preview.warnings).toEqual([]);
		// total_value = Σ final: 14.400 − 2.000.
		expect(ops(plan, 'update_contract')).toEqual([{ kind: 'update_contract', set: { total_value: 12400 }, bypass_end_date_guard: false }]);
	});

	it('quitar el último producto es CHURN con aviso: el estado del contrato no cambia solo (Supuesto)', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] }));

		expect(inserted(plan).map((item) => item.categoria)).toEqual(['CHURN', 'CHURN']);
		expect(plan.event.type).toBe('CHURN');
		expect(plan.preview.warnings.map((warning) => warning.code)).toContain('contract_without_live_items');
		expect(plan.preview.contract.after).toMatchObject({ mrr: 0, status: 'active' });
		// Las PE de diciembre quedan sin líneas → se cancelan.
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({ set: { total_value: 14400 - 2000 - 400 } });
	});

	it('non-renewal (efectiva después del fin): sin espejo, solo churn_date; ΔMRR explícito y RSM desde el mes siguiente al fin', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2027-01-01' }));

		expect(inserted(plan)).toEqual([]);
		expect(ops(plan, 'update_item')).toHaveLength(1);
		expect(ops(plan, 'update_line')).toEqual([]);
		expect(plan.preview.items.ended[0].timing).toBe('non_renewal');
		expect(plan.preview.rsm).toMatchObject({ mrr_delta: -1000, first_month: '2027-01-01' });
		expect(plan.event.subtype).toBe('non_renewal');
	});

	it('emitida con período después de la fecha → NC espejo por los días no consumidos y aviso si no está pagada', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' }));
		const [nc] = ops(plan, 'credit_note') as Array<{ mirrors: { id: string }; lines: Array<{ ratio: number; period_start: string }> }>;

		expect(nc.mirrors.id).toBe('inv-09');
		expect(nc.lines).toEqual([expect.objectContaining({ period_start: '2026-09-15', ratio: 16 / 30 })]);
		// 1.000 × 16/30 = 533,33 neto → 634,67 con IVA, misma moneda y FX que la original.
		expect(plan.preview.invoices.credit_notes).toEqual([
			{
				mirrors_invoice_id: 'inv-09',
				mirrors_invoice_number: 'F-09',
				total: 634.66,
				currency: 'CLP',
				fx: 1,
				detail: expect.objectContaining({ document_type: 'NC' }),
			},
		]);
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['unpaid_invoice_prorated']);
		// Octubre a diciembre: línea quitada; nunca un UPDATE sobre la emitida.
		expect(ops(plan, 'delete_line').map((op) => (op as { line_id: string }).line_id)).toEqual(['line-10-lic', 'line-11-lic', 'line-12-lic']);
		expect(ops(plan, 'update_line')).toEqual([]);
	});

	it('bloqueos: ítem ya churneado, ya renovado, período cerrado, factura unificada; 400 sin motivo o con ítem ajeno', () => {
		const churned = planChange(
			context({ items: [itemRow({ churn_date: '2026-06-30' }), soporteRow()] }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] })
		);

		expect(churned.preview.blockers.map((blocker) => blocker.code)).toEqual(['item_already_churned']);
		expect(churned.preview.can_apply).toBe(false);
		const renewed = planChange(
			context({ items: [itemRow({ renewed_by_item_id: 'x' }), soporteRow()] }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] })
		);

		expect(renewed.preview.blockers.map((blocker) => blocker.code)).toEqual(['item_already_renewed']);
		const closed = planChange(
			context({ contract: { ...context().contract, cutoff_date: '2026-11-30' } }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] })
		);

		expect(closed.preview.blockers[0]).toMatchObject({ code: 'period_closed', next_step: expect.stringContaining('Reabrir') });
		const unified = planChange(
			context({ invoices: [...context().invoices, invoiceRow('12', { id: 'inv-uni', invoice_type: 'Unificada', status: 'Por Emitir' })] }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] })
		);

		expect(unified.preview.blockers.map((blocker) => blocker.code)).toContain('unified_invoice_in_range');
		expect(
			fields(() =>
				planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { reason_id: undefined, reason: undefined }))
			)
		).toEqual(['reason']);
		expect(fields(() => planChange(context(), request({ type: 'item_remove', items: [{ item_id: CONTRACT_ID }] })))).toEqual([
			'change.items.0.item_id',
		]);
	});
});

describe('contract_end_date = mayor fin de los recurrentes vivos en toda modificación (decisión de Domi 01-10)', () => {
	const longer = () =>
		context({
			contract: contractRow({ contract_end_date: '2027-06-30' }),
			items: [itemRow({ end_date: '2027-06-30', term_months: 18 }), soporteRow()],
		});
	const endOf = (plan: ChangePlan) => ops(plan, 'update_contract')[0]?.set.contract_end_date;

	it('item_remove del ítem que define el fin: pasa al siguiente mayor (31-12), nunca al más próximo por defecto', () => {
		const plan = planChange(longer(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-11-15' }));

		expect(endOf(plan)).toBe('2026-12-31');
		expect(ops(plan, 'update_contract')[0].bypass_end_date_guard).toBe(true);
	});
	it('item_remove de un ítem que no define el fin: el fin no se mueve (antes bajaba al más próximo)', () => {
		const plan = planChange(longer(), request({ type: 'item_remove', items: [{ item_id: SOPORTE }] }, { effective_date: '2026-11-15' }));

		expect(endOf(plan)).toBeUndefined();
	});
	it('item_add que co-termina con el mayor fin vivo no mueve el fin del contrato', () => {
		const plan = planChange(
			context({ items: [itemRow(), soporteRow()] }),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10, is_recurring: true, end_date: '2026-12-31' }] },
				{ effective_date: '2026-11-01', reason: 'ok' }
			)
		);

		expect(endOf(plan)).toBeUndefined();
	});
});

describe('effective_date_suggestions en item_remove y pause (mismo formato que contract_cancel)', () => {
	it('item_remove con fecha dentro de un período emitido: sugiere el día después del último período emitido del ítem (sin NC)', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' }));

		expect(plan.preview.effective_date_suggestions).toEqual([
			{
				effective_date: '2026-10-01',
				reason: 'last_issued_period',
				message: 'Terminar el 2026-09-30 (fin del último período emitido): no hace falta nota de crédito',
			},
		]);
		// Con la fecha sugerida ya elegida no se repite.
		const chosen = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-10-01' }));

		expect(chosen.preview.effective_date_suggestions).toEqual([]);
	});
	it('pause: last_issued_period y current_period con el texto de la pausa', () => {
		const plan = planChange(
			context({ today: '2026-10-10' }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-09-20', pause_end: '2026-10-31' })
		);

		expect(plan.preview.effective_date_suggestions).toEqual([
			expect.objectContaining({ effective_date: '2026-10-01', reason: 'last_issued_period' }),
			expect.objectContaining({
				effective_date: '2026-11-01',
				reason: 'current_period',
				message: expect.stringContaining('Pausar desde el 2026-11-01'),
			}),
		]);
	});
});

describe('contract_cancel (M2 total)', () => {
	it('churnea todos los recurrentes, cancela las PE desde la fecha, pasa a Cancelado con motivo y deja CHURN', () => {
		const plan = planChange(context(), request({ type: 'contract_cancel' }, { effective_date: '2026-12-01' }));

		expect(inserted(plan).map((item) => [item.product_name, item.categoria, item.final_price])).toEqual([
			['Licencia', 'CHURN', -1000],
			['Soporte', 'CHURN', -200],
		]);
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(plan.preview.invoices.updated).toEqual([]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: {
				status: 'Cancelado',
				churn_date: '2026-12-01',
				churn_reason_id: 'reason-1',
				churn_reason: 'Presupuesto',
				total_value: 14400 - 1200,
			},
			bypass_end_date_guard: false,
		});
		expect(plan.preview.contract.after).toMatchObject({ mrr: 0, status: 'cancelled' });
		expect(plan.event).toMatchObject({ type: 'CHURN', subtype: 'contract_cancel', amount_delta: -1200 });
	});
	it('un contrato ya cancelado no se cancela de nuevo (not_active)', () => {
		const plan = planChange(context({ contract: contractRowCancelled() }), request({ type: 'contract_cancel' }));

		expect(plan.preview.blockers.map((blocker) => blocker.code)).toContain('not_active');
	});
});

const contractRowCancelled = () => ({ ...context().contract, status: 'Cancelado' });

describe('renewal (M3, mismo precio)', () => {
	it('crea el RENEWAL el día siguiente al fin con renews_item_id, marca renewed_by, genera las facturas nuevas y mueve el fin del contrato', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE, term_months: 6 }] },
				{ effective_date: '2026-12-15', reason: undefined, reason_id: undefined }
			)
		);
		const [licencia, soporte] = inserted(plan);

		expect(licencia).toMatchObject({
			categoria: 'RENEWAL',
			renews_item_id: LICENCIA,
			start_date: '2027-01-01',
			end_date: '2027-12-31',
			term_months: 12,
			quantity: 10,
			unit_price: 100,
			final_price: 12000,
			booking_date: '2026-12-15',
		});
		expect(soporte).toMatchObject({
			renews_item_id: SOPORTE,
			start_date: '2027-01-01',
			end_date: '2027-06-30',
			term_months: 6,
			final_price: 1200,
		});
		expect(ops(plan, 'update_item')).toEqual([
			{ kind: 'update_item', item_id: LICENCIA, set: { renewed_by_key: 'new:1' } },
			{ kind: 'update_item', item_id: SOPORTE, set: { renewed_by_key: 'new:2' } },
		]);
		// 12 facturas nuevas (enero a diciembre 2027; enero a junio con las dos líneas), ninguna fusionada con PE de 2026.
		expect(plan.preview.invoices.created).toHaveLength(12);
		expect(plan.preview.invoices.created[0]).toMatchObject({ issue_date: '2027-01-01', subtotal: 1200, due_date: '2027-01-31' });
		expect(plan.preview.invoices.created[11]).toMatchObject({ issue_date: '2027-12-01', subtotal: 1000 });
		expect(plan.preview.invoices.updated).toEqual([]);
		// Fin del contrato = el MAYOR fin de los recurrentes vivos (decisión 01-10: misma regla que el alta): Licencia renovada a dic 2027.
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { total_value: 14400 + 13200, contract_end_date: '2027-12-31' },
			bypass_end_date_guard: true,
		});
		expect(plan.preview.contract.after).toMatchObject({ end_date: '2027-12-31', status: 'active' });
		expect(plan.event).toMatchObject({ type: 'RENEWAL', amount_delta: 0, items_affected: [LICENCIA, SOPORTE], rsm_from_month: '2027-01-01' });
		expect(plan.preview.warnings).toEqual([]);
	});
	it('D3/MF-h: ajustes con fin distinto al del madre: el que termina después se absorbe y se corta al fin del madre; el que termina antes se avisa (adjustment_not_absorbed)', () => {
		const adjustment = (id: string, quantity: number, end: string) =>
			itemRow({
				id,
				categoria: 'UPSELL',
				related_item_id: LICENCIA,
				quantity,
				monthly_price: quantity * 100,
				billing_period_price: quantity * 100,
				start_date: '2026-10-01',
				end_date: end,
				term_months: 6,
			});
		const plan = planChange(
			context({ items: [itemRow(), soporteRow(), adjustment('up-short', 2, '2026-11-30'), adjustment('up-long', 5, '2027-03-31')] }),
			request({ type: 'renewal', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-12-15', reason: 'ok' })
		);

		// Absorbe Licencia (10) + el ajuste largo (5): 15 × 100.
		expect(inserted(plan)[0]).toMatchObject({
			categoria: 'RENEWAL',
			renews_item_id: LICENCIA,
			quantity: 15,
			unit_price: 100,
			start_date: '2027-01-01',
		});
		expect(ops(plan, 'update_item')).toEqual(
			expect.arrayContaining([
				{ kind: 'update_item', item_id: 'up-long', set: { end_date: '2026-12-31' } },
				{ kind: 'update_item', item_id: 'up-long', set: { renewed_by_key: 'new:1' } },
				{ kind: 'update_item', item_id: LICENCIA, set: { renewed_by_key: 'new:1' } },
			])
		);
		expect(ops(plan, 'update_item').some((op) => op.item_id === 'up-short')).toBe(false);
		expect(plan.event.metadata).toMatchObject({ renewals: [{ item_id: LICENCIA, absorbed: ['up-long'] }] });
		const warning = plan.preview.warnings.find((entry) => entry.code === 'adjustment_not_absorbed');

		expect(warning?.message).toContain('hasta el 2026-11-30');
		expect(plan.preview.warnings.map((entry) => entry.code)).toContain('adjustments_absorbed');
	});
	it('renovación parcial: el fin del contrato pasa al mayor fin vivo (la renovación); retroactiva avisa; Vencido se admite', () => {
		const expired = context({
			contract: contractRow({ contract_end_date: '2026-06-30' }),
			items: [
				itemRow({ end_date: '2026-06-30', term_months: 6, final_price: 6000 }),
				soporteRow({ end_date: '2026-06-30', term_months: 6, final_price: 1200 }),
			],
			invoices: [],
		});
		const plan = planChange(
			expired,
			request({ type: 'renewal', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-28', reason: 'Renovación tardía' })
		);

		expect(plan.preview.contract.before.status).toBe('expired');
		expect(plan.preview.blockers).toEqual([]);
		expect(inserted(plan)[0]).toMatchObject({ start_date: '2026-07-01', end_date: '2026-12-31', term_months: 6 });
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['retroactive_renewal']);
		// Soporte venció sin renovar; el fin del contrato = el mayor fin vivo (la renovación de Licencia, 31-12), no el más próximo.
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { total_value: 6000 + 1200 + 6000, contract_end_date: '2026-12-31' },
			bypass_end_date_guard: true,
		});
		expect(plan.preview.contract.after.status).toBe('pending_renewal');
	});
	it('rechaza catch-up en el mes actual y fin no entero; bloquea ítems churneados o ya renovados (el precio nuevo se acepta, §9.3.4)', () => {
		expect(fields(() => planChange(context(), request({ type: 'renewal', catch_up: 'current_month', items: [{ item_id: LICENCIA }] })))).toEqual([
			'change.catch_up',
		]);
		expect(fields(() => planChange(context(), request({ type: 'renewal', items: [{ item_id: LICENCIA, end_date: '2027-12-15' }] })))).toEqual([
			'change.items.0.end_date',
		]);
		const blocked = planChange(
			context({ items: [itemRow({ renewed_by_item_id: 'x' }), soporteRow({ churn_date: '2026-10-01' })] }),
			request({ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] })
		);

		expect(blocked.preview.blockers.map((blocker) => blocker.code).sort()).toEqual(['item_already_churned', 'item_already_renewed']);
	});
	it('absorbe los ajustes vigentes co-terminados: la renovación parte del valor del ítem madre', () => {
		const upsell = itemRow({
			id: 'up-1',
			categoria: 'UPSELL',
			related_item_id: LICENCIA,
			quantity: 2,
			unit_price: 100,
			monthly_price: 200,
			final_price: 1200,
			term_months: 6,
			start_date: '2026-07-01',
		});
		const plan = planChange(
			context({ items: [itemRow(), upsell], invoices: [] }),
			request({ type: 'renewal', items: [{ item_id: LICENCIA }] }, { reason: 'ok' })
		);

		expect(inserted(plan)[0]).toMatchObject({ quantity: 12, unit_price: 100, final_price: 14400 });
		expect(ops(plan, 'update_item').map((op) => (op as { item_id: string }).item_id)).toEqual([LICENCIA, 'up-1']);
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['adjustments_absorbed']);
	});
});

describe('item_add (M1 alta)', () => {
	it('pago único: el preview marca is_recurring false en "Se agregan" y el ΔMRR queda en 0; los recurrentes van en true', () => {
		const once = planChange(
			context(),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 500, is_recurring: false }] },
				{ reason: 'Capacitación' }
			)
		);

		expect(once.preview.items.added).toHaveLength(1);
		expect(once.preview.items.added[0].is_recurring).toBe(false);
		expect(once.preview.rsm.mrr_delta).toBe(0);
		const recurring = planChange(
			context(),
			request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 2, unit_price: 300 }] }, { reason: 'Módulo' })
		);

		expect(recurring.preview.items.added[0].is_recurring).toBe(true);
	});

	it('cross-sell: producto nuevo hereda del contrato, co-termina (D-B), tramo inicial por días en la factura del ciclo y se suma a la PE del mes', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 2, unit_price: 300, end_date: '2027-06-30' }] },
				{ reason: 'Nuevo módulo' }
			)
		);
		const [item] = inserted(plan);

		expect(item).toMatchObject({
			product_name: 'Analítica',
			categoria: 'CROSS-SELL',
			start_date: '2026-11-15',
			end_date: '2026-12-31',
			term_months: 2,
			billing_frequency: 'Mensual',
			billing_method: 'Anticipado',
			item_type: 'Recurrente',
			currency: 'CLP',
			related_item_id: null,
			// Valor = tramo 16/30 × 600 + diciembre 600 = 920 (Σ facturas = TV).
			final_price: 920,
		});
		// El tramo inicial por días llega del generador como aviso de prorrateo.
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['term_exceeds_contract_capped', 'generator']);
		expect(plan.preview.warnings.find((warning) => warning.code === 'generator')?.message).toMatch(/^Primer período prorrateado: 16 días/);
		// Generador: tramo 15-11 → 30-11 (16/30 × 600 = 320) + diciembre 600, ambos en la factura del ciclo 01-12 → se suma a la PE de diciembre.
		const [create] = ops(plan, 'create_invoices') as Array<{
			invoices: Array<{ issue_date: string; lines: Array<{ subtotal: number }> }>;
			merge_into: Array<string | null>;
		}>;

		expect(create.invoices.map((invoice) => invoice.issue_date)).toEqual(['2026-12-01']);
		expect(create.invoices[0].lines.map((line) => line.subtotal)).toEqual([320, 600]);
		expect(create.merge_into).toEqual(['inv-12']);
		expect(plan.preview.invoices.updated).toEqual([
			expect.objectContaining({ id: 'inv-12', subtotal_before: 1200, subtotal_after: 2120, lines_changed: 2 }),
		]);
		expect(plan.preview.invoices.created).toEqual([]);
		expect(plan.event).toMatchObject({ type: 'CROSS_SELL', amount_delta: 600, rsm_from_month: '2026-11-01' });
		expect(plan.preview.contract.after.mrr).toBe(1800);
	});
	it('tramo inicial suelto (S3-17): la factura del 15-11 nace aparte y no se fusiona; diciembre sí', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_add', first_period_invoice: 'immediate', items: [{ product_id: PRODUCT_NUEVO, quantity: 2, unit_price: 300 }] },
				{ reason: 'ok' }
			)
		);
		const [create] = ops(plan, 'create_invoices') as Array<{
			invoices: Array<{ issue_date: string; due_date: string; subtotal: number }>;
			merge_into: Array<string | null>;
		}>;

		expect(create.invoices.map((invoice) => [invoice.issue_date, invoice.subtotal])).toEqual([
			['2026-11-15', 320],
			['2026-12-01', 600],
		]);
		expect(create.invoices[0].due_date).toBe('2026-12-15');
		expect(create.merge_into).toEqual([null, 'inv-12']);
		expect(plan.preview.invoices.created).toHaveLength(1);
	});
	it('producto existente es UPSELL de ítem nuevo con aviso y ítem relacionado (Supuesto 2); duplicado avisa; solo Activo', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 100, start_date: '2026-12-01' }] },
				{ effective_date: '2026-12-01', reason: 'ok' }
			)
		);

		expect(inserted(plan)[0]).toMatchObject({
			categoria: 'UPSELL',
			related_item_id: LICENCIA,
			start_date: '2026-12-01',
			end_date: '2026-12-31',
			term_months: 1,
		});
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['upsell_of_existing_product']);
		expect(plan.event.type).toBe('UPSELL');
		const pending = planChange(
			context({ items: [itemRow({ end_date: '2026-06-30' }), soporteRow()] }),
			request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10, end_date: '2026-12-31' }] })
		);

		expect(pending.preview.blockers.map((blocker) => blocker.code)).toEqual(['not_active']);
	});
	it('D3/MF-h: el UPSELL de un producto existente termina con su ítem relacionado, no con el contrato (salvo end_date o term_months explícitos)', () => {
		// Licencia (relacionado) termina el 30-06-2027; Soporte el 31-12-2026 (fin del contrato que rige).
		const longer = context({ items: [itemRow({ end_date: '2027-06-30', term_months: 18 }), soporteRow()] });
		const add = (item: Record<string, unknown>) =>
			planChange(
				longer,
				request(
					{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 100, start_date: '2026-12-01', ...item }] },
					{ effective_date: '2026-12-01', reason: 'ok' }
				)
			);
		const follows = add({});

		expect(inserted(follows)[0]).toMatchObject({ related_item_id: LICENCIA, end_date: '2027-06-30', term_months: 7 });
		expect(follows.preview.warnings.map((warning) => warning.code)).not.toContain('term_exceeds_contract_capped');
		// Explícitos: `end_date` y `term_months` mandan (acotados al fin del relacionado).
		expect(inserted(add({ end_date: '2027-02-28' }))[0]).toMatchObject({ end_date: '2027-02-28', term_months: 3 });
		expect(inserted(add({ term_months: 2 }))[0]).toMatchObject({ end_date: '2027-01-31', term_months: 2 });
		const capped = add({ end_date: '2027-12-31' });

		expect(inserted(capped)[0]).toMatchObject({ end_date: '2027-06-30' });
		expect(capped.preview.warnings.map((warning) => warning.code)).toContain('term_exceeds_contract_capped');
		expect(fields(() => add({ term_months: 0 }))).toEqual(['change.items.0.term_months']);

		// Relacionado que termina ANTES que el contrato: el ajuste no lo sobrevive.
		const shorter = planChange(
			context({ items: [itemRow({ end_date: '2026-11-30', term_months: 11 }), soporteRow()] }),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 100, start_date: '2026-11-01' }] },
				{ effective_date: '2026-11-01', reason: 'ok' }
			)
		);

		expect(inserted(shorter)[0]).toMatchObject({ related_item_id: LICENCIA, end_date: '2026-11-30', term_months: 1 });
		// Cross-sell (sin relacionado): co-termina con el fin del contrato (el mayor fin vivo: Licencia 30-06-2027).
		const cross = planChange(
			longer,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10 }] },
				{ effective_date: '2026-11-01', reason: 'ok' }
			)
		);

		expect(inserted(cross)[0]).toMatchObject({ categoria: 'CROSS-SELL', related_item_id: null, end_date: '2027-06-30' });
	});
	it('Pricing v2: `price` inline se valida como al crear, tarifa las facturas del ítem y fija el unitario mensual equivalente; medido + Anticipado → 400', () => {
		const price = {
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [
				{ from: 1, to: 100, per_unit_amount: 2 },
				{ from: 101, to: null, per_unit_amount: 1 },
			],
		};
		const plan = planChange(
			context(),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 150, price }] },
				{ effective_date: '2026-12-01', reason: 'ok' }
			)
		);
		const [item] = inserted(plan);

		// 100 × 2 + 50 × 1 = 250 por período mensual → unitario mensual equivalente 250 / 150 = 1,666667; el precio viaja en price_spec.
		expect(item).toMatchObject({ categoria: 'CROSS-SELL', quantity: 150, unit_price: 1.666667, price_entry_mode: 'monthly', price_id: null });
		expect(item.price_spec).toMatchObject({
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [expect.objectContaining({ from: 1, to: 100 }), expect.objectContaining({ from: 101, to: null })],
		});
		const [create] = ops(plan, 'create_invoices');

		expect(create.invoices[0].lines[0]).toMatchObject({ quantity: 150, subtotal: 250, quantity_source: 'fixed' });
		expect(create.invoices[0].lines[0].pricing.breakdown.map((row: { kind: string; amount: number }) => [row.kind, row.amount])).toEqual([
			['tier', 200],
			['tier', 50],
		]);
		expect(plan.preview.contract.after.mrr).toBe(1450);
		// Tramos con hueco → 400 en el campo del precio; medido + Anticipado → 400 en billing_method; métrica ajena → 400.
		expect(
			fields(() =>
				planChange(
					context(),
					request({
						type: 'item_add',
						items: [
							{
								product_id: PRODUCT_NUEVO,
								quantity: 1,
								price: {
									...price,
									tiers: [
										{ from: 1, to: 100, per_unit_amount: 2 },
										{ from: 200, to: null, per_unit_amount: 1 },
									],
								},
							},
						],
					})
				)
			)[0]
		).toMatch(/^change\.items\.0\.price\./);
		const metered = { model: 'standard', quantity_type: 'metered', unit_amount: 0.5, billable_metric_id: 'm-1' };

		expect(
			fields(() =>
				planChange(
					context({ billable_metrics: new Map([['m-1', 'active']]) }),
					request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, price: metered }] })
				)
			)
		).toEqual(['change.items.0.billing_method']);
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, price: metered, billing_method: 'Vencido' }] })
				)
			)
		).toEqual(['change.items.0.price.billable_metric_id']);
		expect(
			planChange(
				context({ billable_metrics: new Map([['m-1', 'active']]) }),
				request(
					{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, price: metered, billing_method: 'Vencido' }] },
					{ reason: 'ok' }
				)
			).preview.can_apply
		).toBe(true);
		// Sin precio y sin unitario → 400.
		expect(fields(() => planChange(context(), request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1 }] })))).toEqual([
			'change.items.0.unit_price',
		]);
	});

	it('item_add con price_id (etapa 3): copia el modelo del catálogo (activo, mismo producto y moneda) al ítem nuevo con list_price_id', () => {
		const CATALOG = 'ca000000-0000-4000-8000-000000000001';
		const catalog = (overrides: Partial<CatalogPrice> = {}): CatalogPrice => ({
			id: CATALOG,
			name: 'Tramos LatAm',
			product_id: PRODUCT_NUEVO,
			currency: 'CLP',
			status: 'active',
			version: 2,
			spec: {
				model: 'graduated',
				quantity_type: 'fixed',
				billable_metric_id: null,
				unit_amount: null,
				tiers: [
					{ from: 1, to: 100, per_unit_amount: 2, flat_amount: 0 },
					{ from: 101, to: null, per_unit_amount: 1, flat_amount: 0 },
				],
				package_size: null,
				package_amount: null,
				seat_minimum_quantity: 0,
				free_units: 0,
				minimum_amount: null,
				cap_amount: null,
				invoice_line_mode: 'per_tier',
				charge_flat_when_free: false,
			},
			...overrides,
		});
		const withCatalog = (row: CatalogPrice | null) => context({ catalog_prices: new Map(row ? [[CATALOG, row]] : []) });
		const add = (item: Record<string, unknown>, overrides = {}) =>
			request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 150, price_id: CATALOG, ...item }] }, overrides);
		const plan = planChange(withCatalog(catalog()), add({}, { reason: 'ok' }));
		const [item] = inserted(plan);

		// 150 unidades: 100 × 2 + 50 × 1 = 250 del período → unitario mensual equivalente 1,6667; nada de unit_price en el body.
		expect(item).toMatchObject({ product_name: 'Analítica', list_price_id: CATALOG, price_name: 'Tramos LatAm', unit_price: 1.666667 });
		expect(item.price_spec).toMatchObject({ model: 'graduated', invoice_line_mode: 'per_tier' });
		expect(plan.preview.can_apply).toBe(true);

		const message = (ctx: ReturnType<typeof context>, item: Record<string, unknown> = {}) => {
			try {
				planChange(ctx, add(item));
			} catch (error) {
				return fieldErrorsOf(error)!.map((entry) => `${entry.field}: ${entry.message}`);
			}
			throw new Error('se esperaba un 400');
		};

		expect(message(withCatalog(null))).toEqual([`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.missing}`]);
		expect(message(withCatalog(catalog({ status: 'draft' })))).toEqual([`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.draft}`]);
		expect(message(withCatalog(catalog({ status: 'archived' })))).toEqual([`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.archived}`]);
		expect(message(withCatalog(catalog({ product_id: PRODUCT_LICENCIA })))).toEqual([
			`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.product}`,
		]);
		expect(message(withCatalog(catalog({ currency: 'USD' })))).toEqual([
			`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.currency('USD', 'CLP')}`,
		]);
		// Inline y catálogo a la vez → 400 (el inline standard fijo no cuenta como modelo).
		expect(message(withCatalog(catalog()), { price: { model: 'package', quantity_type: 'fixed', package_size: 10, package_amount: 5 } })).toEqual(
			[`change.items.0.price_id: ${CATALOG_PRICE_MESSAGES.both}`]
		);
		// Medido del catálogo + Anticipado → misma regla que el inline.
		const metered = catalog({
			spec: { ...catalog().spec, model: 'standard', quantity_type: 'metered', unit_amount: 0.5, tiers: null, billable_metric_id: 'm-1' },
		});

		expect(fields(() => planChange(withCatalog(metered), add({ billing_method: 'Anticipado' })))).toEqual(['change.items.0.billing_method']);
	});

	it('400: producto ajeno, inicio antes de la fecha efectiva, sin fin heredable; bloqueos de cotización (S3-3, ya aplicada)', () => {
		expect(
			fields(() => planChange(context(), request({ type: 'item_add', items: [{ product_id: ENTITY_NEW, quantity: 1, unit_price: 1 }] })))
		).toEqual(['change.items.0.product_id']);
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 1, start_date: '2026-11-01' }] })
				)
			)
		).toEqual(['change.items.0.start_date']);
		expect(
			fields(() =>
				planChange(context({ items: [] }), request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 1 }] }))
			)
		).toEqual(['change.items.0.end_date']);
		const quote = planChange(
			context({ quote: { id: 'q-1', quote_type: 'Nuevo cliente', already_applied: true } }),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 1 }] },
				{ origin: { type: 'quote', quote_id: 'q-1' } }
			)
		);

		expect(quote.preview.blockers.map((blocker) => blocker.code).sort()).toEqual([
			'new_business_quote_on_existing_contract',
			'quote_already_applied',
		]);
	});
});

describe('item_change (M1 precio/cantidad)', () => {
	it('upsell por cantidad: delta desde la fecha efectiva, línea propia prorrateada y sumada a las PE del mes', () => {
		const plan = planChange(
			context(),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100 }] }, { reason: 'ok' })
		);
		const [delta] = inserted(plan);

		// Valor = 16/30 × 200 + 200 = 306,67 (Σ facturas = TV); el mensual +200 lo deriva el trigger de qty × unit.
		expect(delta).toMatchObject({
			categoria: 'UPSELL',
			quantity: 2,
			unit_price: 100,
			start_date: '2026-11-15',
			end_date: '2026-12-31',
			term_months: 2,
			final_price: 306.67,
			related_item_id: LICENCIA,
		});
		const [create] = ops(plan, 'create_invoices') as Array<{
			invoices: Array<{ issue_date: string; lines: Array<{ subtotal: number }> }>;
			merge_into: Array<string | null>;
		}>;

		// Tramo 15-11 → 30-11 (16/30 × 200 = 106,67) + diciembre 200, en la factura del ciclo 01-12 → PE de diciembre.
		expect(create.invoices[0].lines.map((line) => line.subtotal)).toEqual([106.67, 200]);
		expect(create.merge_into).toEqual(['inv-12']);
		expect(plan.event).toMatchObject({ type: 'UPSELL', subtype: 'quantity', amount_delta: 200 });
		expect(plan.preview.contract).toMatchObject({ before: { mrr: 1200 }, after: { mrr: 1400 } });
		expect(plan.preview.items.groups_after.find((group) => group.product_name === 'Licencia')).toMatchObject({ quantity: 12, mrr: 1200 });
	});
	it('downsell rige desde el próximo inicio de período sin prorrateo (S3-5/6) y reescribe la línea base al neto (S3-14)', () => {
		const plan = planChange(
			context(),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 8, unit_price: 100 }] }, { reason: 'ok' })
		);
		const [delta] = inserted(plan);

		expect(delta).toMatchObject({
			categoria: 'DOWNSELL',
			quantity: 2,
			unit_price: -100,
			start_date: '2026-12-01',
			term_months: 1,
			final_price: -200,
		});
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['downsell_from_next_period']);
		// Noviembre no se toca; diciembre queda neta: 8 × 100 = 800.
		expect(ops(plan, 'update_line')).toEqual([
			{
				kind: 'update_line',
				invoice_id: 'inv-12',
				line_id: 'line-12-lic',
				values: { quantity: 8, unit_price: 100, discount_pct: 0, subtotal: 800, tax_amount: 152, total: 952 },
			},
		]);
		expect(ops(plan, 'create_invoices')).toEqual([]);
		expect(plan.preview.invoices.updated).toEqual([expect.objectContaining({ id: 'inv-12', subtotal_before: 1200, subtotal_after: 1000 })]);
		expect(plan.event).toMatchObject({ type: 'DOWNSELL', subtype: 'quantity', amount_delta: -200, rsm_from_month: '2026-12-01' });
	});
	it('renegociación (dos ejes) con la fórmula unificada: STG-38 da UPSELL +51,20 con qty −20', () => {
		const stg = itemRow({ quantity: 160, unit_price: 13.68, monthly_price: 2188.8, final_price: 26265.6 });
		const plan = planChange(
			context({ items: [stg, soporteRow()], invoices: [] }),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 140, unit_price: 16 }] },
				{ effective_date: '2026-12-01', reason: 'ok' }
			)
		);

		expect(inserted(plan)[0]).toMatchObject({ categoria: 'UPSELL', quantity: -20, unit_price: -2.56, final_price: 51.2 });
		expect(plan.event).toMatchObject({ type: 'UPSELL', subtype: 'RENEGOTIATION', amount_delta: 51.2 });
		expect(plan.preview.items.groups_after.find((group) => group.product_name === 'Licencia')).toMatchObject({ quantity: 140, mrr: 2240 });
	});
	it('bloquea si ya está facturado en firme después de la fecha (con fecha sugerida) y rechaza fin, sin cambio y 100 % (la frecuencia es §9.3.7)', () => {
		const blocked = planChange(
			context(),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100 }] }, { effective_date: '2026-09-15' })
		);

		expect(blocked.preview.blockers[0]).toMatchObject({ code: 'issued_after_effective_date', next_step: expect.stringContaining('2026-10-01') });
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 100, end_date: '2027-06-30' }] })
				)
			)
		).toEqual(['change.items.0.end_date', 'change.items.0.quantity']);
		const overrides = planChange(
			context({ quantity_override_item_ids: [LICENCIA] }),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100 }] }, { reason: 'ok' })
		);

		expect(overrides.preview.warnings.map((warning) => warning.code)).toEqual(['quantity_overrides_present', 'generator']);
	});

	describe('MF-b / Huecos #4b: ítem con modelo de precio (tramos fijos)', () => {
		// Licencia graduada: 1–5 a 100 y 6+ a 50 → 10 unidades = 500 + 250 = 750 al mes.
		const tiers = [
			{ from: 1, to: 5, per_unit_amount: 100, flat_amount: 0 },
			{ from: 6, to: null, per_unit_amount: 50, flat_amount: 0 },
		];
		const tieredItem = (mode: 'per_tier' | 'single') =>
			itemRow({
				unit_price: 75,
				monthly_price: 750,
				billing_period_price: 750,
				price_id: 'price-lic',
				raw: {
					price_id: 'price-lic',
					price_model: 'graduated',
					price_quantity_type: 'fixed',
					price_tiers: tiers,
					price_invoice_line_mode: mode,
				},
			});
		// Por Emitir oct–dic con las dos filas por tramo de Licencia (5 × 100 y 5 × 50) más Soporte.
		const tieredInvoices = () =>
			context().invoices.map((invoice) => {
				if (invoice.status !== 'Por Emitir') return invoice;
				const [lic, sop] = invoice.lines;
				const rows = [
					{ ...lic, id: `${lic.id}-t1`, quantity: 5, unit_price: 100, subtotal: 500, tax_amount: 95, total: 595 },
					{ ...lic, id: `${lic.id}-t2`, quantity: 5, unit_price: 50, subtotal: 250, tax_amount: 47.5, total: 297.5 },
				];

				return { ...invoice, subtotal: 950, lines: [...rows, sop] };
			});
		const change = (mode: 'per_tier' | 'single', quantity: number) =>
			planChange(
				context({ items: [tieredItem(mode), soporteRow()], invoices: tieredInvoices() }),
				request(
					{ type: 'item_change', items: [{ item_id: LICENCIA, quantity, unit_price: 75 }] },
					{ effective_date: '2026-11-01', reason: 'ok' }
				)
			);

		it('per_tier: 10 → 20 re-tarifa con el motor y conserva una fila por tramo con su desglose (no aplana a 1 × total)', () => {
			const plan = change('per_tier', 20);

			// Se quitan las dos filas viejas de nov y dic (oct no: el cambio rige el 01-11); Soporte intacto.
			expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual([
				'line-11-lic-t1',
				'line-11-lic-t2',
				'line-12-lic-t1',
				'line-12-lic-t2',
			]);
			expect(ops(plan, 'update_line')).toEqual([]);
			const merges = ops(plan, 'create_invoices');

			expect(merges.map((op) => op.merge_into)).toEqual([['inv-11'], ['inv-12']]);
			const rows = merges[0].invoices[0].lines;

			// 20 unidades: 5 × 100 + 15 × 50 = 1.250, dos filas con su sublínea de tramo.
			expect(rows.map((line: PreviewLine) => [line.item_key, line.quantity, line.unit_price, line.subtotal])).toEqual([
				[LICENCIA, 5, 100, 500],
				[LICENCIA, 15, 50, 750],
			]);
			expect(rows[1].pricing?.breakdown).toEqual([expect.objectContaining({ kind: 'tier', quantity: 15, unit_amount: 50, amount: 750 })]);
			expect(rows[0].line_part).toMatchObject({ index: 0, count: 2 });
			// El delta (ΔMRR) sale del motor: 1.250 − 750 = +500; el unitario indicado (75) no se usa y se avisa.
			expect(plan.event).toMatchObject({ type: 'UPSELL', amount_delta: 500 });
			expect(plan.preview.warnings.map((warning) => warning.code)).toContain('priced_item_engine_price');
			expect(plan.preview.invoices.updated.find((entry) => entry.id === 'inv-11')).toMatchObject({
				subtotal_before: 950,
				subtotal_after: 1450,
			});
		});

		it('single: una fila con la cantidad nueva y el desglose del motor; downsell 10 → 4 deja solo el primer tramo', () => {
			const up = change('single', 20);
			const [row] = ops(up, 'create_invoices')[0].invoices[0].lines;

			expect([row.quantity, row.subtotal]).toEqual([20, 1250]);
			expect(row.pricing?.breakdown.map((sub: PricedSubline) => [sub.quantity, sub.amount])).toEqual([
				[5, 500],
				[15, 750],
			]);
			const down = change('per_tier', 4);
			const [rows] = ops(down, 'create_invoices').map((op) => op.invoices[0].lines);

			expect(rows.map((line: PreviewLine) => [line.quantity, line.unit_price, line.subtotal])).toEqual([[4, 100, 400]]);
			expect(down.event).toMatchObject({ type: 'DOWNSELL', amount_delta: -350 });
		});

		it('per_tier con consumo registrado (Huecos F4-C): el período con consumo se re-tarifa por tramo con la cantidad registrada (no se aplana)', () => {
			// Noviembre tiene consumo registrado de 12 (5 × 100 + 7 × 50 = 850) en dos filas por tramo.
			const invoices = tieredInvoices().map((invoice) =>
				invoice.id !== 'inv-11'
					? invoice
					: {
							...invoice,
							subtotal: 1050,
							lines: invoice.lines.map((line) =>
								line.contract_item_id !== LICENCIA
									? line
									: {
											...line,
											quantity: line.id.endsWith('t1') ? 5 : 7,
											subtotal: line.id.endsWith('t1') ? 500 : 350,
											quantity_source: 'consumption',
											consumption: { quantity: 12, amount_override: null, apply_item_discount: true, is_estimated: false },
										}
							),
						}
			);
			const plan = planChange(
				context({ items: [tieredItem('per_tier'), soporteRow()], invoices }),
				request(
					{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 20, unit_price: 75 }] },
					{ effective_date: '2026-11-01', reason: 'ok' }
				)
			);
			const merges = ops(plan, 'create_invoices');
			const rowsOf = (index: number) =>
				merges[index].invoices[0].lines.map((line: PreviewLine) => [line.quantity, line.unit_price, line.subtotal, line.quantity_source]);

			expect(ops(plan, 'update_line')).toEqual([]);
			expect(merges.map((op) => op.merge_into)).toEqual([['inv-11'], ['inv-12']]);
			// Noviembre: la cantidad registrada (12) en dos filas por tramo, con origen consumo; diciembre: la base nueva (20).
			expect(rowsOf(0)).toEqual([
				[5, 100, 500, 'consumption'],
				[7, 50, 350, 'consumption'],
			]);
			expect(rowsOf(1)).toEqual([
				[5, 100, 500, 'fixed'],
				[15, 50, 750, 'fixed'],
			]);
			expect(merges[0].invoices[0].lines[1].pricing?.breakdown).toEqual([
				expect.objectContaining({ kind: 'tier', quantity: 7, amount: 350, line_index: 1, line_count: 2 }),
			]);
			expect(plan.preview.warnings.map((warning) => warning.code)).toContain('consumption_quantity_kept');
			expect(plan.preview.invoices.updated.find((entry) => entry.id === 'inv-11')).toMatchObject({
				subtotal_before: 1050,
				subtotal_after: 1050,
			});
		});
	});
});

describe('billing_conditions (fase A)', () => {
	it('condición de pago: solo el contrato, con aviso de cuántas PE conservan el vencimiento (S4-10)', () => {
		const plan = planChange(
			context(),
			request({ type: 'billing_conditions', payment_terms: { kind: 'net', days: 45 } }, { effective_date: '2026-11-01', reason: 'ok' })
		);

		expect(ops(plan, 'update_contract')).toEqual([
			{ kind: 'update_contract', set: { payment_terms: { kind: 'net', days: 45 } }, bypass_end_date_guard: false },
		]);
		expect(plan.preview.warnings).toEqual([{ code: 'pending_invoices_keep_old_terms', message: expect.stringContaining('2 factura(s)') }]);
		expect(plan.preview.invoices.updated).toEqual([]);
		expect(plan.event).toMatchObject({
			type: 'CONDITIONS_UPDATED',
			rsm_from_month: null,
			metadata: expect.objectContaining({ changed_fields: ['payment_terms'] }),
		});
		expect(plan.preview.rsm.first_month).toBeNull();
	});
	it('condiciones de factura: aviso keep_old_terms sin apply_to_pending; con él lo informa el servicio; sin cambio de texto → 400', () => {
		const terms = (applyToPending?: boolean) =>
			planChange(
				context(),
				request(
					{ type: 'billing_conditions', invoice_terms_and_conditions: 'Pago a 30 días', apply_to_pending: applyToPending },
					{ effective_date: '2026-11-01', reason: 'ok' }
				)
			);

		expect(terms(false).preview.warnings.map((warning) => warning.code)).toEqual(['pending_invoices_keep_old_terms']);
		expect(terms(true).preview.warnings).toEqual([]);
		expect(ops(terms(true), 'update_contract')[0].set).toEqual({ invoice_terms_and_conditions: 'Pago a 30 días' });
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', auto_send_to_odoo: true, apply_to_pending: true })))).toEqual(
			['apply_to_pending']
		);
		expect(fields(() => planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }], apply_to_pending: true })))).toEqual(
			['apply_to_pending']
		);
	});
	it('emisión automática exige envío al ERP (S6-10); emisión y referencias se propagan a las PE desde la fecha efectiva', () => {
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', auto_invoice: true })))).toEqual(['change.auto_invoice']);
		const plan = planChange(
			context(),
			request(
				{ type: 'billing_conditions', auto_send_to_odoo: true, auto_invoice: true, requires_references_for_billing: true },
				{ effective_date: '2026-12-01' }
			)
		);

		expect(ops(plan, 'update_invoices_fields')).toEqual([
			{ kind: 'update_invoices_fields', invoice_ids: ['inv-12'], set: { auto_invoice: true, requires_references_for_billing: true } },
		]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { auto_send_to_odoo: true, auto_invoice: true, requires_references_for_billing: true },
		});
		expect(plan.preview.invoices.updated).toHaveLength(1);
	});
	it('moneda y política FX de facturación: fijo con tasa valoriza las PE; UF bloquea; sin tasa para un período bloquea', () => {
		const plan = planChange(
			context(),
			request(
				{
					type: 'billing_conditions',
					invoice_currency: 'USD',
					fx_invoice_policy: 'fixed',
					fx_invoice_rates: [{ rate: 0.001, period_start: '2026-11-01', period_end: '2026-12-31' }],
				},
				{ effective_date: '2026-11-01' }
			)
		);

		expect(ops(plan, 'update_invoices_fx')).toEqual([
			{
				kind: 'update_invoices_fx',
				invoice_currency: 'USD',
				targets: [
					{ invoice_id: 'inv-11', fx: 0.001 },
					{ invoice_id: 'inv-12', fx: 0.001 },
				],
			},
		]);
		expect(ops(plan, 'insert_fx_rates')).toEqual([
			{
				kind: 'insert_fx_rates',
				rates: [{ from_currency: 'CLP', to_currency: 'USD', rate: 0.001, period_start: '2026-11-01', period_end: '2026-12-31' }],
			},
		]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: expect.objectContaining({ invoice_currency: 'USD', fx_invoice_policy: 'fixed' }),
		});
		expect(planChange(context(), request({ type: 'billing_conditions', invoice_currency: 'CLF' })).preview.blockers[0].code).toBe(
			'uf_invoice_currency'
		);
		const missing = planChange(
			context(),
			request(
				{
					type: 'billing_conditions',
					invoice_currency: 'USD',
					fx_invoice_policy: 'fixed',
					fx_invoice_rates: [{ rate: 0.001, period_start: '2026-11-01', period_end: '2026-11-30' }],
				},
				{ effective_date: '2026-11-01' }
			)
		);

		expect(missing.preview.blockers.map((blocker) => blocker.code)).toEqual(['fixed_fx_without_rate']);
		// Spot: las PE quedan con FX null (se valorizan al emitir).
		const spot = planChange(
			context(),
			request({ type: 'billing_conditions', invoice_currency: 'USD', fx_invoice_policy: 'spot' }, { effective_date: '2026-11-01' })
		);

		expect((ops(spot, 'update_invoices_fx')[0] as { targets: unknown[] }).targets).toEqual([
			{ invoice_id: 'inv-11', fx: null },
			{ invoice_id: 'inv-12', fx: null },
		]);
	});
	it('documento tributario solo (ronda 4, Domi 03-10): bloqueo tax_document_requires_party_change (409 al aplicar); no toca facturas', () => {
		const plan = planChange(
			context({ tax_document_type: { id: 'tdt-110', code: '110', name: 'Factura de exportación electrónica', kind: 'export_invoice' } }),
			request({ type: 'billing_conditions', tax_document_type_id: 'tdt-110' }, { effective_date: '2026-11-01' })
		);

		expect(plan.preview.can_apply).toBe(false);
		expect(plan.preview.blockers).toEqual([
			expect.objectContaining({
				code: 'tax_document_requires_party_change',
				message: 'El documento tributario solo cambia junto con la razón social emisora o receptora',
			}),
		]);
		expect(ops(plan, 'update_invoices_document')).toEqual([]);
		// Sin catálogo: la familia sola tampoco cambia.
		const family = planChange(context(), request({ type: 'billing_conditions', document_type: 'FACTURA_EXPORTACION' }));

		expect(family.preview.blockers.map((blocker) => blocker.code)).toEqual(['tax_document_requires_party_change']);
		// Documento inexistente o de otro país → 400 (como antes); sin cambios → 400.
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', tax_document_type_id: 'tdt-x' })))).toEqual([
			'change.tax_document_type_id',
		]);
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', payment_terms: { kind: 'net', days: 30 } })))).toEqual([
			'change',
		]);
	});
	it('mismo documento que ya tiene no cuenta como cambio (no bloquea)', () => {
		const base = context().contract;
		const withDoc = {
			...base,
			document_type: 'FACTURA',
			tax_document_type_id: 'tdt-33',
			tax_document_type_kind: 'invoice',
			tax_document_tax_rate: 19,
		};
		const plan = planChange(
			context({ contract: withDoc, tax_document_type: { id: 'tdt-33', code: '33', name: 'Factura', kind: 'invoice', tax_rate: 19 } }),
			request({ type: 'billing_conditions', tax_document_type_id: 'tdt-33', auto_send_to_odoo: true }, { effective_date: '2026-11-01' })
		);

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'update_invoices_document')).toEqual([]);
	});
	it('se admite en borrador y no en cancelado', () => {
		expect(
			planChange(
				context({ contract: { ...context().contract, status: 'En revisión' } }),
				request({ type: 'billing_conditions', auto_send_to_odoo: true })
			).preview.blockers
		).toEqual([]);
		expect(
			planChange(context({ contract: contractRowCancelled() }), request({ type: 'billing_conditions', auto_send_to_odoo: true })).preview
				.blockers[0].code
		).toBe('not_active');
	});
});

describe('change_entity (M5)', () => {
	const entity = { id: ENTITY_NEW, legal_name: 'Cliente Norte SpA', tax_id: '78.888.888-8', country: 'Chile', belongs_to_client: true };

	it('reasigna el contrato y las PE desde la fecha efectiva; evento ENTITY_CHANGED sin ítems ni RSM', () => {
		const plan = planChange(
			context({ new_entity: entity }),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW }, { effective_date: '2026-12-01' })
		);

		expect(ops(plan, 'update_invoices_fields')).toEqual([
			// El IVA de la Por Emitir se re-deriva de su documento y se guarda normalizado (como el editor, `taxRateForDocument`).
			{
				kind: 'update_invoices_fields',
				invoice_ids: ['inv-12'],
				set: { client_entity_id: ENTITY_NEW, client_tax_id: '78.888.888-8', tax_rate: 19 },
			},
		]);
		expect(ops(plan, 'update_contract')).toEqual([
			{ kind: 'update_contract', set: { client_entity_id: ENTITY_NEW, legal_client_name: 'Cliente Norte SpA' }, bypass_end_date_guard: false },
		]);
		expect(ops(plan, 'update_invoices_document')).toEqual([]);
		expect(plan.event).toMatchObject({
			type: 'ENTITY_CHANGED',
			rsm_from_month: null,
			metadata: expect.objectContaining({ pending_invoices_updated: 1 }),
		});
		expect(plan.preview.invoices.updated).toEqual([expect.objectContaining({ id: 'inv-12', change: 'receptor Cliente Norte SpA' })]);
	});
	it('razón social de otro país sin catálogo re-deriva el documento (exportación, IVA 0) con aviso; con catálogo solo avisa', () => {
		const plan = planChange(
			context({ new_entity: { ...entity, country: 'Perú' } }),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW }, { effective_date: '2026-11-01' })
		);

		expect(ops(plan, 'update_invoices_document')[0]).toMatchObject({
			document_type: 'FACTURA_EXPORTACION',
			tax_rate: 0,
			invoice_ids: ['inv-11', 'inv-12'],
		});
		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['document_type_changed']);
		const catalog = planChange(
			context({ new_entity: { ...entity, country: 'Perú' }, contract: { ...context().contract, tax_document_type_id: 'tdt-33' } }),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW })
		);

		expect(catalog.preview.warnings.map((warning) => warning.code)).toEqual(['document_type_review']);
		expect(ops(catalog, 'update_invoices_document')).toEqual([]);
	});
	it('ronda 4: documento tributario junto con la razón social: lo guarda y recalcula el IVA de las PE desde la fecha efectiva', () => {
		const base = context().contract;
		const withDoc = {
			...base,
			document_type: 'FACTURA',
			tax_document_type_id: 'tdt-33',
			tax_document_type_kind: 'invoice',
			tax_document_tax_rate: 19,
		};
		const plan = planChange(
			context({
				new_entity: entity,
				contract: withDoc,
				tax_document_type: { id: 'tdt-34', code: '34', name: 'Factura exenta', kind: 'invoice', tax_rate: 0 },
			}),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW, tax_document_type_id: 'tdt-34' }, { effective_date: '2026-11-01' })
		);

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { client_entity_id: ENTITY_NEW, tax_document_type_id: 'tdt-34', document_type: 'FACTURA' },
		});
		expect(ops(plan, 'update_invoices_fields')).toEqual([
			{
				kind: 'update_invoices_fields',
				invoice_ids: ['inv-11', 'inv-12'],
				set: { client_entity_id: ENTITY_NEW, client_tax_id: '78.888.888-8' },
			},
		]);
		expect(ops(plan, 'update_invoices_document')).toEqual([
			{ kind: 'update_invoices_document', invoice_ids: ['inv-11', 'inv-12'], document_type: 'FACTURA', export_type: 0, tax_rate: 0 },
		]);
		expect(plan.event.metadata).toMatchObject({
			tax_document_before: { id: 'tdt-33' },
			tax_document_after: { id: 'tdt-34', document_type: 'FACTURA', tax_rate: 0 },
		});
		expect(plan.preview.invoices.updated[0].change).toContain('documento 34 Factura exenta, IVA 0 %');
		// Exportación con la razón social extranjera: familia FACTURA_EXPORTACION e IVA 0.
		const exportPlan = planChange(
			context({
				new_entity: { ...entity, country: 'Perú' },
				contract: withDoc,
				tax_document_type: { id: 'tdt-110', code: '110', name: 'Factura de exportación electrónica', kind: 'export_invoice' },
			}),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW, tax_document_type_id: 'tdt-110' }, { effective_date: '2026-11-01' })
		);

		expect(ops(exportPlan, 'update_invoices_document')[0]).toMatchObject({ document_type: 'FACTURA_EXPORTACION', export_type: 1, tax_rate: 0 });
		expect(exportPlan.preview.warnings.map((warning) => warning.code)).not.toContain('document_type_review');
		// Documento que no es del país de la compañía → 400.
		expect(
			fields(() =>
				planChange(
					context({ new_entity: entity }),
					request({ type: 'change_entity', client_entity_id: ENTITY_NEW, tax_document_type_id: 'tdt-x' })
				)
			)
		).toEqual(['change.tax_document_type_id']);
	});
	it('400: cliente comercial (ABIERTO), razón social ajena al cliente, la misma; bloqueo por período cerrado (guard del contrato)', () => {
		expect(
			fields(() =>
				planChange(context({ new_entity: entity }), request({ type: 'change_entity', client_entity_id: ENTITY_NEW, client_id: 'other' }))
			)
		).toEqual(['change.client_id']);
		expect(
			fields(() =>
				planChange(
					context({ new_entity: { ...entity, belongs_to_client: false } }),
					request({ type: 'change_entity', client_entity_id: ENTITY_NEW })
				)
			)
		).toEqual(['change.client_entity_id']);
		expect(
			fields(() =>
				planChange(context({ new_entity: { ...entity, id: 'entity-1' } }), request({ type: 'change_entity', client_entity_id: 'entity-1' }))
			)
		).toEqual(['change.client_entity_id']);
		const closed = planChange(
			context({ new_entity: entity, contract: { ...context().contract, cutoff_date: '2026-03-31' } }),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW })
		);

		expect(closed.preview.blockers[0]).toMatchObject({ code: 'period_closed', next_step: expect.stringContaining('Reabrir') });
	});
});

describe('tipos diferidos y forma del pedido', () => {
	it('price_adjustment → 400 explicando el camino (pacto); items obligatorios en los tipos de ítems', () => {
		expect(fields(() => planChange(context(), request({ type: 'price_adjustment' })))).toEqual(['change.type']);
		expect(fields(() => planChange(context(), request({ type: 'item_remove' })))).toEqual(['change.items']);
		expect(fields(() => planChange(context(), request({ type: 'item_add' }, { origin: { type: 'quote' } as never })))).toEqual([
			'origin.quote_id',
			'change.items',
		]);
	});
});

describe('ediciones manuales de una Por Emitir (spec facturas §3.4)', () => {
	it('la baja no quita ni reescribe una línea editada a mano (quantity_source = manual): la deja y avisa manual_edit_kept', () => {
		const invoices = context().invoices.map((invoice) =>
			invoice.id === 'inv-12'
				? {
						...invoice,
						lines: invoice.lines.map((line) => (line.contract_item_id === LICENCIA ? { ...line, quantity_source: 'manual' } : line)),
					}
				: invoice
		);
		const plan = planChange(context({ invoices }), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }));

		expect(ops(plan, 'delete_line')).toEqual([]);
		// Noviembre (no manual) se sigue prorrateando.
		expect(ops(plan, 'update_line').map((op) => op.line_id)).toEqual(['line-11-lic']);
		expect(plan.preview.warnings).toContainEqual({
			code: 'manual_edit_kept',
			message: expect.stringContaining('editada a mano'),
		});
		expect(plan.preview.invoices.updated.map((invoice) => invoice.id)).toEqual(['inv-11']);
	});
});

describe('auditoría 01-10: facturas por OC, borrador en el ERP, anuladas, NC previas y consumo registrado', () => {
	type Invoice = ReturnType<typeof invoiceRow>;
	const withInvoice = (id: string, patch: (invoice: Invoice) => Invoice) =>
		context().invoices.map((invoice) => (invoice.id === id ? patch(invoice) : invoice));
	/** La Por Emitir pasa a facturada por OC: su segunda línea es interna (ligada a la visible). */
	const partial = (invoice: Invoice): Invoice => ({
		...invoice,
		lines: invoice.lines.map((line, index) => (index === 1 ? { ...line, visible_line_id: invoice.lines[0].id } : line)),
	});
	const licenciaLine = (invoice: Invoice, patch: Partial<Invoice['lines'][number]>): Invoice => ({
		...invoice,
		lines: invoice.lines.map((line) => (line.contract_item_id === LICENCIA ? { ...line, ...patch } : line)),
	});
	const codes = (plan: ChangePlan) => plan.preview.warnings.map((warning) => warning.code);

	it('item_remove: la Por Emitir facturada por OC no se toca y se lista con el paso siguiente; la que tiene borrador en el ERP sigue con aviso', () => {
		const invoices = withInvoice('inv-12', partial).map((invoice) => (invoice.id === 'inv-11' ? { ...invoice, odoo_invoice_id: 77 } : invoice));
		const plan = planChange(context({ invoices }), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }));

		expect(ops(plan, 'delete_line')).toEqual([]);
		expect(ops(plan, 'update_line').map((op) => op.invoice_id)).toEqual(['inv-11']);
		expect(plan.preview.can_apply).toBe(true);
		expect(plan.preview.warnings).toContainEqual({
			code: 'partial_billing_skipped',
			message: expect.stringContaining('por OC'),
			next_step: 'Edítala desde su vista rápida',
		});
		expect(plan.preview.warnings).toContainEqual({
			code: 'erp_draft_stale',
			message: expect.stringContaining(
				'La factura ya tiene un borrador en el ERP: elimínalo allí y restablece el borrador aquí para reenviarla'
			),
			next_step: expect.any(String),
		});
		expect(plan.event.metadata.warnings).toEqual(expect.arrayContaining(['partial_billing_skipped', 'erp_draft_stale']));
	});

	it('item_remove: una emitida anulada no recibe otra NC; la NC proporcional descuenta las NC de descuento previas de la línea', () => {
		const voided = planChange(
			context({ invoices: withInvoice('inv-09', (invoice) => ({ ...invoice, voided: true })) }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' })
		);

		expect(ops(voided, 'credit_note')).toEqual([]);
		expect(voided.preview.invoices.credit_notes).toEqual([]);
		const credited = planChange(
			context({ invoices: withInvoice('inv-09', (invoice) => licenciaLine(invoice, { previously_credited: 500 })) }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' })
		);
		const [nc] = ops(credited, 'credit_note') as Array<{ lines: Array<{ ratio: number }> }>;

		// Quedan 500 de 1.000 en la línea: se acredita 16/30 de lo que queda (266,67 neto → 317,34 con IVA).
		expect(nc.lines[0].ratio).toBeCloseTo((16 / 30) * 0.5, 10);
		expect(credited.preview.invoices.credit_notes[0].total).toBe(317.34);
	});

	it('item_remove: la línea con consumo registrado del período que contiene la fecha no se prorratea (conserva la cantidad)', () => {
		const invoices = withInvoice('inv-11', (invoice) =>
			licenciaLine(invoice, {
				quantity: 7,
				quantity_source: 'consumption',
				consumption: { quantity: 7, amount_override: null, apply_item_discount: true, is_estimated: false },
			})
		);
		const plan = planChange(context({ invoices }), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }));

		expect(ops(plan, 'update_line')).toEqual([]);
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-12-lic']);
		expect(codes(plan)).toContain('consumption_line_kept');
	});

	it('contract_cancel (§9.3.1): las líneas a mano ya no bloquean (entran a la decisión); la facturada por OC con cancel se cancela entera, con emit queda', () => {
		const manual = planChange(
			context({ invoices: withInvoice('inv-12', (invoice) => licenciaLine(invoice, { quantity_source: 'manual' })) }),
			request({ type: 'contract_cancel', invoice_decisions: [{ invoice_id: 'inv-12', action: 'cancel' }] }, { effective_date: '2026-12-01' })
		);

		expect(manual.preview.blockers.map((blocker) => blocker.code)).not.toContain('manual_lines_pending');
		expect(manual.preview.can_apply).toBe(true);
		expect(manual.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(manual.preview.invoice_decisions_required?.[0]).toMatchObject({
			invoice_id: 'inv-12',
			reason_hint: expect.stringContaining('a mano'),
		});
		const po = planChange(
			context({ invoices: withInvoice('inv-12', partial) }),
			request({ type: 'contract_cancel', invoice_decisions: [{ invoice_id: 'inv-12', action: 'cancel' }] }, { effective_date: '2026-12-01' })
		);

		expect(po.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(ops(po, 'cancel_invoice').map((op) => op.invoice_id)).toEqual(['inv-12']);
		expect(ops(po, 'delete_line')).toEqual([]);
		const kept = planChange(
			context({ invoices: withInvoice('inv-12', partial) }),
			request({ type: 'contract_cancel', invoice_decisions: [{ invoice_id: 'inv-12', action: 'emit' }] }, { effective_date: '2026-12-01' })
		);

		expect(kept.preview.invoices.cancelled).toEqual([]);
		expect(codes(kept)).toContain('billed_beyond_effective_date');
	});

	it('item_change: la línea sumada no cae en una Por Emitir por OC (mergeTarget la salta y avisa)', () => {
		const plan = planChange(
			context({ invoices: withInvoice('inv-12', partial) }),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100 }] })
		);
		const [create] = ops(plan, 'create_invoices') as Array<{ merge_into: Array<string | null> }>;

		expect(create.merge_into).toEqual([null]);
		expect(codes(plan)).toContain('partial_billing_skipped');
	});

	it('item_change de precio: la línea con consumo registrado conserva la cantidad consumida y se tarifa al precio nuevo con su desglose', () => {
		const invoices = withInvoice('inv-12', (invoice) =>
			licenciaLine(invoice, {
				quantity: 7,
				unit_price: 100,
				subtotal: 700,
				tax_amount: 133,
				total: 833,
				quantity_source: 'consumption',
				consumption: { quantity: 7, amount_override: null, apply_item_discount: true, is_estimated: false },
			})
		);
		const plan = planChange(
			context({ invoices }),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 120 }] })
		);
		const [update] = ops(plan, 'update_line');

		expect(update).toMatchObject({
			invoice_id: 'inv-12',
			line_id: 'line-12-lic',
			// 7 consumidas (nunca las 10 base) × 120 = 840 neto + IVA 19 %.
			values: { quantity: 7, unit_price: 120, subtotal: 840, tax_amount: 159.6, total: 999.6, quantity_source: 'consumption' },
		});
		expect(update.values.pricing_breakdown).toEqual([expect.objectContaining({ kind: 'tier', quantity: 7, unit_amount: 120, amount: 840 })]);
		// Con consumo la línea es neta (no se agrega una línea del delta encima del consumo).
		expect(ops(plan, 'create_invoices')).toEqual([]);
		expect(codes(plan)).toEqual(expect.arrayContaining(['consumption_net_line', 'consumption_quantity_kept']));
	});

	it('billing_conditions FX: la línea con consumo no se reescribe; se saltan las por OC y las de tasa fijada por factura (aviso)', () => {
		const invoices = context()
			.invoices.map((invoice) =>
				invoice.id === 'inv-12'
					? licenciaLine(invoice, {
							quantity: 7,
							quantity_source: 'consumption',
							consumption: { quantity: 7, amount_override: null, apply_item_discount: true, is_estimated: false },
						})
					: invoice
			)
			.map((invoice) =>
				invoice.id === 'inv-11' ? { ...invoice, lines: invoice.lines.map((line) => ({ ...line, fx_rate_source: 'net_exact' })) } : invoice
			)
			.map((invoice) => (invoice.id === 'inv-10' ? partial(invoice) : invoice));
		const plan = planChange(
			context({ invoices }),
			request(
				{
					type: 'billing_conditions',
					invoice_currency: 'USD',
					fx_invoice_policy: 'fixed',
					fx_invoice_rates: [{ rate: 0.001, period_start: '2026-10-01', period_end: '2026-12-31' }],
				},
				{ effective_date: '2026-10-01' }
			)
		);

		expect(ops(plan, 'update_invoices_fx')).toEqual([
			{ kind: 'update_invoices_fx', invoice_currency: 'USD', targets: [{ invoice_id: 'inv-12', fx: 0.001 }] },
		]);
		// Solo cambia la moneda/tasa: ninguna línea (tampoco la de consumo) se reescribe ni se quita.
		expect(ops(plan, 'update_line')).toEqual([]);
		expect(ops(plan, 'delete_line')).toEqual([]);
		expect(codes(plan)).toEqual(expect.arrayContaining(['invoice_fx_kept', 'partial_billing_skipped']));
	});

	it('change_entity: re-deriva el IVA de cada Por Emitir (como el editor), omite las por OC y guarda el antes por factura', () => {
		const invoices = withInvoice('inv-11', (invoice) => ({ ...invoice, tax_rate: 0, client_tax_id: '77.777.777-7' })).map((invoice) =>
			invoice.id === 'inv-12' ? partial(invoice) : invoice
		);
		const plan = planChange(
			context({
				invoices,
				new_entity: { id: ENTITY_NEW, legal_name: 'Cliente Norte SpA', tax_id: '78.888.888-8', country: 'Chile', belongs_to_client: true },
			}),
			request({ type: 'change_entity', client_entity_id: ENTITY_NEW }, { effective_date: '2026-11-01' })
		);

		expect(ops(plan, 'update_invoices_fields')).toEqual([
			{
				kind: 'update_invoices_fields',
				invoice_ids: ['inv-11'],
				set: { client_entity_id: ENTITY_NEW, client_tax_id: '78.888.888-8', tax_rate: 19 },
			},
		]);
		expect(ops(plan, 'update_invoices_document')).toEqual([
			{ kind: 'update_invoices_document', invoice_ids: ['inv-11'], document_type: 'FACTURA', export_type: 0, tax_rate: 19 },
		]);
		expect(plan.event.metadata.invoices_before).toEqual([{ id: 'inv-11', client_entity_id: 'entity-1', client_tax_id: '77.777.777-7' }]);
		expect(codes(plan)).toEqual(expect.arrayContaining(['tax_rate_rederived', 'partial_billing_skipped']));
	});

	it('taxRateFor (modificaciones) aplica la misma regla que taxRateForDocument del editor', () => {
		const contract = context().contract;

		for (const doc of ['FACTURA', 'FACTURA_EXPORTACION'])
			expect(taxRateFor(doc, contract)).toBe(taxRateForDocument(doc, contract.company.country, contract.company.tax_rate));
		const colombia = { ...contract, company: { ...contract.company, country: 'Colombia' } };

		expect(taxRateFor('FACTURA', colombia)).toBe(taxRateForDocument('FACTURA', 'Colombia', contract.company.tax_rate));
		// Ronda 3: con documento del catálogo, los dos caminos usan su tasa (misma función `resolveTaxRate`).
		const exenta = { ...contract, tax_document_type_id: 'tdt-34', tax_document_type_kind: 'invoice', tax_document_tax_rate: 0 };
		const document = { kind: 'invoice', tax_rate: 0 };

		expect(taxRateFor('FACTURA', exenta)).toBe(0);
		expect(taxRateForDocument('FACTURA', contract.company.country, contract.company.tax_rate, document)).toBe(0);
		// Un documento de exportación no fija la tasa de una factura nacional; exportación siempre 0.
		expect(taxRateForDocument('FACTURA', 'Chile', 19, { kind: 'export_invoice', tax_rate: 0 })).toBe(19);
		expect(taxRateForDocument('FACTURA_EXPORTACION', 'Chile', 19, { kind: 'invoice', tax_rate: 19 })).toBe(0);
	});
});

describe('item_update (§9.2, corregir un dato: datos no comerciales)', () => {
	const change = (items: Array<Record<string, unknown>>) => request({ type: 'item_update', items } as never);
	const pendingLic = ['line-10-lic', 'line-11-lic', 'line-12-lic'];

	it('cambia la cuenta (recortada), sin espejos, ΔMRR, RSM ni precios; regenera las glosas de las PE del ítem y lo avisa', () => {
		const plan = planChange(context(), change([{ item_id: LICENCIA, account: '  Norte  ' }]));

		expect(plan.ops).toEqual([
			{ kind: 'update_item', item_id: LICENCIA, set: { account: 'Norte' } },
			{ kind: 'regenerate_descriptions', line_ids: pendingLic },
		]);
		expect(plan.preview.items_after).toEqual([
			{
				item_id: LICENCIA,
				product_name: 'Licencia',
				account_before: null,
				account: 'Norte',
				changes: [{ field: 'account', before: null, after: 'Norte' }],
			},
		]);
		expect(plan.preview.items).toMatchObject({ added: [], adjusted: [], ended: [] });
		expect(plan.preview.rsm).toMatchObject({ mrr_delta: 0, first_month: null, momentum: null });
		expect(plan.preview.contract.after).toEqual(plan.preview.contract.before);
		expect(plan.preview.invoices).toEqual({ updated: [], created: [], cancelled: [], credit_notes: [] });
		expect(plan.preview.warnings).toEqual([
			expect.objectContaining({ code: 'pending_descriptions_updated', message: expect.stringContaining('3 líneas') }),
		]);
		expect(plan.preview.can_apply).toBe(true);
		expect(plan.event).toMatchObject({
			type: 'ITEM_CORRECTED',
			subtype: 'data',
			amount_delta: 0,
			items_affected: [LICENCIA],
			rsm_from_month: null,
			metadata: expect.objectContaining({
				items: [{ item_id: LICENCIA, product_name: 'Licencia', changes: [{ field: 'account', before: null, after: 'Norte' }] }],
			}),
		});
		expect(plan.items_after.find((item) => item.id === LICENCIA)!.account).toBe('Norte');
	});

	it('vacío → NULL; no regenera glosas protegidas, editadas a mano ni de PE con borrador en el ERP; emitidas nunca', () => {
		const invoices = context().invoices.map((invoice) => {
			if (invoice.id === 'inv-10')
				return { ...invoice, lines: invoice.lines.map((line) => (line.id === 'line-10-lic' ? { ...line, description_locked: true } : line)) };
			if (invoice.id === 'inv-11')
				return {
					...invoice,
					lines: invoice.lines.map((line) => (line.id === 'line-11-lic' ? { ...line, quantity_source: 'manual' } : line)),
				};
			if (invoice.id === 'inv-12') return { ...invoice, odoo_invoice_id: 77 };

			return invoice;
		});
		const plan = planChange(
			context({ items: [itemRow({ account: 'Norte' }), soporteRow()], invoices }),
			change([{ item_id: LICENCIA, account: '   ' }])
		);

		expect(plan.ops).toEqual([{ kind: 'update_item', item_id: LICENCIA, set: { account: null } }]);
		expect(plan.preview.warnings).toEqual([]);
		expect(plan.event.metadata.items).toEqual([
			{ item_id: LICENCIA, product_name: 'Licencia', changes: [{ field: 'account', before: 'Norte', after: null }] },
		]);
		expect(plan.event.description).toBe('"Licencia": cuenta Norte → sin cuenta');
	});

	it('mismo producto y cuenta con el mismo inicio → possible_duplicate', () => {
		const twin = itemRow({ id: '33333333-3333-4333-8333-333333333333', account: 'Norte' });
		const plan = planChange(context({ items: [itemRow(), soporteRow(), twin], invoices: [] }), change([{ item_id: LICENCIA, account: 'Norte' }]));

		expect(plan.preview.warnings.map((warning) => warning.code)).toEqual(['possible_duplicate']);
		expect(plan.preview.can_apply).toBe(true);
	});

	it('el producto completo (con su ajuste del mismo inicio) se mueve junto sin possible_duplicate', () => {
		const adjustment = itemRow({ id: '44444444-4444-4444-8444-444444444444', categoria: 'UPSELL', related_item_id: LICENCIA, account: null });
		const plan = planChange(
			context({ items: [itemRow(), soporteRow(), adjustment], invoices: [] }),
			change([
				{ item_id: LICENCIA, account: 'Norte' },
				{ item_id: adjustment.id, account: 'Norte' },
			])
		);

		expect(plan.preview.warnings).toEqual([]);
		expect(ops(plan, 'update_item').map((op) => op.item_id)).toEqual([LICENCIA, adjustment.id]);
	});

	it('se admite en Pausado y Vencido; no en En revisión ni Cancelado', () => {
		const states = ['Pausado', 'En revisión', 'Cancelado'].map(
			(status) => planChange(context({ contract: contractRow({ status }) }), change([{ item_id: LICENCIA, account: 'Norte' }])).preview
		);

		expect(states.map((preview) => preview.can_apply)).toEqual([true, false, false]);
		expect(states[1].blockers[0].code).toBe('not_active');
		const expired = planChange(
			context({ items: [itemRow({ end_date: '2026-06-30' }), soporteRow({ end_date: '2026-06-30' })] }),
			change([{ item_id: LICENCIA, account: 'Norte' }])
		);

		expect(expired.preview.contract.before.status).toBe('expired');
		expect(expired.preview.can_apply).toBe(true);
	});

	it('ítem ajeno → bloqueo item_not_found; sin campos, misma cuenta, repetido o lista vacía → 400', () => {
		const missing = planChange(context(), change([{ item_id: 'e0000000-0000-4000-8000-000000000099', account: 'Norte' }]));

		expect(missing.preview.blockers.map((blocker) => blocker.code)).toEqual(['item_not_found']);
		expect(missing.ops).toEqual([]);
		expect(fields(() => planChange(context(), change([{ item_id: LICENCIA }])))).toEqual(['change.items.0']);
		expect(fields(() => planChange(context(), change([{ item_id: LICENCIA, account: null }])))).toEqual(['change.items.0.account']);
		expect(
			fields(() =>
				planChange(
					context(),
					change([
						{ item_id: LICENCIA, account: 'A' },
						{ item_id: LICENCIA, account: 'B' },
					])
				)
			)
		).toEqual(['change.items.1.item_id']);
		expect(fields(() => planChange(context(), change([])))).toEqual(['change.items']);
	});
});

describe('item_update · corregir un dato mal cargado (F4, decisión 01-10)', () => {
	const correct = (items: Array<Record<string, unknown>>, overrides: Partial<Parameters<typeof context>[0]> = {}, effective = '2026-09-28') =>
		planChange(context(overrides), request({ type: 'item_update', items } as never, { effective_date: effective }));

	it('corrección en su lugar: sin espejo ni UPSELL, misma categoría y booking; precios con los helpers; TCV y devengo completo', () => {
		const plan = correct([{ item_id: LICENCIA, quantity: 12 }]);

		expect(inserted(plan)).toEqual([]);
		expect(ops(plan, 'update_item')).toEqual([
			{
				kind: 'update_item',
				item_id: LICENCIA,
				set: {
					quantity: 12,
					unit_price: 100,
					annual_unit_price: 1200,
					annual_price: 14400,
					price_entry_mode: 'monthly',
					discount_type: null,
					discount_value: 0,
					price: 14400,
					final_price: 14400,
					monthly_price: 1200,
					billing_period_price: 1200,
				},
			},
		]);
		const after = plan.items_after.find((item) => item.id === LICENCIA)!;

		expect([after.categoria, after.booking_date]).toEqual(['NEW', '2026-01-01']);
		expect(plan.preview.contract.after).toMatchObject({ total_value: 16800, mrr: 1400 });
		expect(plan.preview.rsm).toMatchObject({ first_month: '2026-01-01', momentum: 'ITEM_CORRECTED' });
		expect(plan.event).toMatchObject({
			type: 'ITEM_CORRECTED',
			subtype: 'value',
			amount_delta: 0,
			rsm_from_month: '2026-01-01',
			description: '"Licencia": cantidad 10 → 12',
			metadata: expect.objectContaining({
				items: [{ item_id: LICENCIA, product_name: 'Licencia', changes: [{ field: 'quantity', before: 10, after: 12 }] }],
			}),
		});
		expect(plan.preview.items.adjusted.map((item) => [item.item_id, item.quantity, item.monthly_price])).toEqual([[LICENCIA, 12, 1200]]);
	});

	it('emitidas intactas: la diferencia (9 × 200) se reparte en partes iguales entre las 3 Por Emitir con su motivo en invoice_adjustments', () => {
		const plan = correct([{ item_id: LICENCIA, quantity: 12 }]);
		const lines = ops(plan, 'update_line');

		// Ninguna emitida (enero–septiembre) se toca; las PE de Licencia pasan a 12 × 100 = 1.200 + 600 de ajuste (unitario 150).
		expect(lines.map((op) => [op.line_id, op.values.quantity, op.values.unit_price, op.values.subtotal, op.values.tax_amount])).toEqual([
			['line-10-lic', 12, 150, 1800, 342],
			['line-11-lic', 12, 150, 1800, 342],
			['line-12-lic', 12, 150, 1800, 342],
		]);
		expect(ops(plan, 'insert_invoice_adjustment').map((op) => [op.invoice_id, op.type, op.amount_diff])).toEqual([
			['inv-10', 'correction', 600],
			['inv-11', 'correction', 600],
			['inv-12', 'correction', 600],
		]);
		expect(plan.preview.issued_difference).toMatchObject({
			item_id: LICENCIA,
			currency: 'CLP',
			amount: 1800,
			distributed_over: [
				{ invoice_id: 'inv-10', amount: 600 },
				{ invoice_id: 'inv-11', amount: 600 },
				{ invoice_id: 'inv-12', amount: 600 },
			],
		});
		expect(plan.preview.issued_difference!.issued_invoices).toHaveLength(9);
		expect(plan.preview.issued_difference!.issued_invoices[0]).toEqual({
			invoice_id: 'inv-01',
			invoice_number: 'F-01',
			issue_date: '2026-01-01',
			issued: 1000,
			expected: 1200,
			difference: 200,
		});
		expect(plan.preview.warnings.find((warning) => warning.code === 'issued_difference_distributed')?.message).toBe(
			'Ya existen las facturas F-01, F-02, F-03 y 6 más emitidas por este ítem: la diferencia de CLP 1.800,00 se distribuye entre las 3 facturas por emitir. Si lo que quieres es cambiar el acuerdo desde una fecha, usa Cambió el precio o la cantidad'
		);
		expect(plan.preview.invoices.updated.map((entry) => [entry.id, entry.subtotal_before, entry.subtotal_after])).toEqual([
			['inv-10', 1200, 2000],
			['inv-11', 1200, 2000],
			['inv-12', 1200, 2000],
		]);
		expect(plan.preview.invoices.credit_notes).toEqual([]);
	});

	it('reparto telescópico: suma exacta y redondeo en la parte del medio (100 / 3 = 33,33 + 33,34 + 33,33; también negativo)', () => {
		expect(telescopicShares(100, 3)).toEqual([33.33, 33.34, 33.33]);
		expect(telescopicShares(-100, 3)).toEqual([-33.33, -33.34, -33.33]);
		expect(telescopicShares(10, 1)).toEqual([10]);
		// Una emitida con diferencia de 100 (precio 100 → 110 en septiembre) repartida entre las 3 Por Emitir.
		const invoices = context().invoices.filter((invoice) => invoice.id >= 'inv-09');
		const plan = correct([{ item_id: LICENCIA, unit_price: 110 }], { invoices });

		expect(plan.preview.issued_difference).toMatchObject({
			amount: 100,
			distributed_over: [{ amount: 33.33 }, { amount: 33.34 }, { amount: 33.33 }],
		});
		expect(ops(plan, 'update_line').map((op) => op.values.subtotal)).toEqual([1133.33, 1133.34, 1133.33]);
		expect(plan.preview.warnings.find((warning) => warning.code === 'issued_difference_distributed')?.message).toMatch(
			/^Ya existe la factura F-09 emitida por este ítem: la diferencia de CLP 100,00 se distribuye entre las 3 facturas por emitir/
		);
	});

	it('guard: el mes de la fecha efectiva debe estar abierto (period_closed); sin Por Emitir donde repartir → no_pending_invoices_for_correction', () => {
		const closed = correct([{ item_id: LICENCIA, quantity: 12 }], { contract: contractRow({ cutoff_date: '2026-09-30' }) });

		expect(closed.preview.blockers.map((blocker) => blocker.code)).toEqual(['period_closed']);
		// La cuenta (dato no comercial) no pide período abierto.
		expect(correct([{ item_id: LICENCIA, account: 'Norte' }], { contract: contractRow({ cutoff_date: '2026-09-30' }) }).preview.can_apply).toBe(
			true
		);
		const issuedOnly = context().invoices.filter((invoice) => invoice.status !== 'Por Emitir');
		const none = correct([{ item_id: LICENCIA, quantity: 12 }], { invoices: issuedOnly });

		expect(none.preview.blockers).toEqual([
			{
				code: 'no_pending_invoices_for_correction',
				message: expect.stringContaining('CLP 1.800,00'),
				next_step: 'Usa "Cambió el precio o la cantidad" para cambiar el acuerdo desde una fecha',
			},
		]);
		// Sin emitidas del ítem no hay diferencia: se corrige sin bloqueo aunque no haya facturas.
		expect(correct([{ item_id: LICENCIA, quantity: 12 }], { invoices: [] }).preview.can_apply).toBe(true);
	});

	it('respeta lo hecho a mano en las Por Emitir: línea editada, glosa escrita, descuento puntual, consumo y tasa por factura', () => {
		const invoices = context()
			.invoices.filter((invoice) => invoice.status === 'Por Emitir')
			.map((invoice) => ({
				...invoice,
				lines: invoice.lines.map((line) => {
					if (line.id === 'line-10-lic') return { ...line, quantity_source: 'manual' };
					if (line.id === 'line-11-lic')
						return {
							...line,
							description_locked: true,
							discount_pct: 10,
							subtotal: 900,
							pricing_breakdown: [
								{
									kind: 'discount' as const,
									one_off: true,
									amount: -100,
									label: 'Descuento puntual: cortesía',
									quantity: 1,
									one_off_type: 'amount',
									one_off_value: 100,
									base_discount_pct: 0,
								},
							],
						};
					if (line.id === 'line-12-lic')
						return {
							...line,
							fx_rate_source: 'manual',
							quantity: 7,
							subtotal: 700,
							quantity_source: 'consumption',
							consumption: { quantity: 7, amount_override: null, apply_item_discount: true, is_estimated: false },
						};

					return line;
				}),
			}));
		const plan = correct([{ item_id: LICENCIA, unit_price: 110 }], { invoices });
		const lines = ops(plan, 'update_line');

		// Octubre (editada a mano) no se toca; noviembre conserva su descuento puntual de 100 sobre 1.100; diciembre su consumo (7).
		expect(lines.map((op) => [op.line_id, op.values.quantity, op.values.unit_price, op.values.discount_pct, op.values.subtotal])).toEqual([
			['line-11-lic', 10, 110, 9.090909, 1000],
			['line-12-lic', 7, 110, 0, 770],
		]);
		expect(lines[0].values.pricing_breakdown).toEqual([expect.objectContaining({ kind: 'discount', one_off: true, amount: -100 })]);
		expect(lines[1].values.pricing_breakdown).toBeNull();
		const preserved = plan.preview.warnings.find((warning) => warning.code === 'correction_overrides_preserved')!.message;

		expect(preserved).toContain('la línea editada a mano de la factura del 2026-10-01');
		expect(preserved).toContain('la glosa escrita a mano de la factura del 2026-11-01');
		expect(preserved).toContain('el descuento puntual de la factura del 2026-11-01');
		expect(preserved).toContain('la cantidad consumida registrada en la factura del 2026-12-01 (7)');
		expect(preserved).toContain('el tipo de cambio fijado en la factura del 2026-12-01');
		// La glosa se regenera solo en las líneas sin protección (ni la escrita a mano ni la editada).
		expect(ops(plan, 'regenerate_descriptions')).toEqual([{ kind: 'regenerate_descriptions', line_ids: ['line-12-lic'] }]);
		expect(plan.event.metadata.preserved).toHaveLength(5);
	});

	it('glosa, tipo, precio anual y descuento: cambios antes → después; un solo ítem con valor por cambio; sin modelo de precio ni espejos', () => {
		const plan = correct(
			[
				{
					item_id: LICENCIA,
					product_name: ' Licencia Pro ',
					item_type: 'Licencias',
					price_entry_mode: 'annual',
					unit_price: 1440,
					discount_value: 10,
				},
			],
			{
				invoices: [],
			}
		);

		expect(plan.preview.items_after![0].changes).toEqual([
			{ field: 'product_name', before: 'Licencia', after: 'Licencia Pro' },
			{ field: 'item_type', before: 'Recurrente', after: 'Licencias' },
			{ field: 'price_entry_mode', before: 'monthly', after: 'annual' },
			{ field: 'unit_price', before: 100, after: 1440 },
			{ field: 'discount_value', before: 0, after: 10 },
		]);
		expect(ops(plan, 'update_item')[0].set).toMatchObject({
			product_name: 'Licencia Pro',
			item_type: 'Licencias',
			unit_price: 120,
			annual_unit_price: 1440,
			price_entry_mode: 'annual',
			discount_type: 'Porcentaje',
			discount_value: 10,
			final_price: 12960,
			monthly_price: 1080,
		});
		expect(plan.event.description).toBe(
			'"Licencia": glosa Licencia → Licencia Pro · tipo Recurrente → Licencias · precio ingresado mensual → anual · precio 100 → 1.440 · descuento 0 % → 10 %'
		);
		expect(
			fields(() =>
				correct([
					{ item_id: LICENCIA, quantity: 2 },
					{ item_id: SOPORTE, quantity: 2 },
				])
			)
		).toEqual(['change.items']);
		expect(fields(() => correct([{ item_id: LICENCIA, quantity: 0 }]))).toEqual(['change.items.0.quantity']);
		expect(fields(() => correct([{ item_id: LICENCIA, product_name: '  ' }]))).toEqual(['change.items.0.product_name']);
		expect(fields(() => correct([{ item_id: LICENCIA, quantity: 10 }]))).toEqual(['change.items.0']);
		const priced = itemRow({
			price_id: 'p',
			raw: {
				price_id: 'p',
				price_model: 'graduated',
				price_quantity_type: 'fixed',
				price_tiers: [{ from: 1, to: null, per_unit_amount: 100, flat_amount: 0 }],
			},
		});

		expect(fields(() => correct([{ item_id: LICENCIA, quantity: 12 }], { items: [priced, soporteRow()] }))).toEqual(['change.items.0']);
		const mirror = itemRow({ id: '55555555-5555-4555-8555-555555555555', categoria: 'DOWNSELL', related_item_id: LICENCIA });

		expect(fields(() => correct([{ item_id: mirror.id, quantity: 3 }], { items: [itemRow(), soporteRow(), mirror] }))).toEqual([
			'change.items.0',
		]);
		// Glosa y tipo con cuenta de otro ítem en el mismo cambio: datos de varios ítems sí se corrigen juntos.
		expect(
			correct([
				{ item_id: LICENCIA, item_type: 'X' },
				{ item_id: SOPORTE, account: 'Sur' },
			]).preview.can_apply
		).toBe(true);
	});
});

describe('preview por factura (`detail`): la factura real antes → después', () => {
	it('baja: la PE prorrateada lleva sus líneas (cambiada / igual) y Neto, IVA y Total antes → después; la que pierde la línea la marca quitada', () => {
		const plan = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }));
		const [november, december] = plan.preview.invoices.updated;

		expect(november.detail).toMatchObject({
			document_type: 'FACTURA',
			issue_date: '2026-11-01',
			billing_period_start: '2026-11-01',
			tax_rate: 19,
			before: { subtotal: 1200, tax: 228, total: 1428 },
			after: { subtotal: 666.67, tax: 126.67, total: 793.34 },
			invoice_currency_amounts: null,
		});
		expect(november.detail!.lines.map((line) => [line.product_name, line.status, line.before?.subtotal ?? null, line.subtotal])).toEqual([
			['Licencia', 'changed', 1000, 466.67],
			['Soporte', 'same', null, 200],
		]);
		expect(november.detail!.lines[0].billing_period_end).toBe('2026-11-14');
		expect(december.detail!.lines.map((line) => [line.product_name, line.status])).toEqual([
			['Licencia', 'removed'],
			['Soporte', 'same'],
		]);
		expect(december.detail!.after).toEqual({ subtotal: 200, tax: 38, total: 238 });
	});

	it('anulada: todas sus líneas quitadas y sin "después"; NC espejo con sus líneas acreditadas y totales', () => {
		const all = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] }));
		const [cancelled] = all.preview.invoices.cancelled;

		expect(cancelled.detail).toMatchObject({ before: { subtotal: 1200, tax: 228, total: 1428 }, after: null });
		expect(cancelled.detail!.lines.every((line) => line.status === 'removed')).toBe(true);

		const credited = planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' }));
		const [note] = credited.preview.invoices.credit_notes;

		expect(note.detail).toMatchObject({ document_type: 'NC', before: null, after: { subtotal: 533.33, tax: 101.33, total: 634.66 } });
		expect(note.detail!.lines).toEqual([
			expect.objectContaining({ product_name: 'Licencia', status: 'added', subtotal: 533.33, billing_period_start: '2026-09-15' }),
		]);
	});

	it('alta que se funde con la PE del mes: las líneas del generador entran como agregadas', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 2, unit_price: 300, end_date: '2027-06-30' }] },
				{ reason: 'Nuevo módulo' }
			)
		);
		const [december] = plan.preview.invoices.updated;

		expect(december.detail!.lines.map((line) => [line.product_name, line.status, line.subtotal])).toEqual([
			['Licencia', 'same', 1000],
			['Soporte', 'same', 200],
			['Analítica', 'added', 320],
			['Analítica', 'added', 600],
		]);
		expect(december.detail!.after).toEqual({ subtotal: 2120, tax: 402.8, total: 2522.8 });
	});
});

describe('item_update · corregir la fecha de inicio (caso CTR-2026-191, decisión 07-10)', () => {
	const ANALITICA = '33333333-3333-4333-8333-333333333333';
	const LAST: Record<string, string> = { '09': '30', '10': '31', '11': '30', '12': '31' };
	const analitica = (overrides: Partial<ReturnType<typeof itemRow>> = {}) =>
		itemRow({
			id: ANALITICA,
			product_id: PRODUCT_NUEVO,
			product_name: 'Analítica',
			categoria: 'CROSS-SELL',
			quantity: 1,
			unit_price: 300,
			annual_unit_price: 3600,
			monthly_price: 300,
			billing_period_price: 300,
			price: 1200,
			final_price: 1200,
			term_months: 4,
			start_date: '2026-09-01',
			end_date: '2026-12-31',
			booking_date: '2026-09-01',
			...overrides,
		});
	/** Factura propia de Analítica del mes `mm` (300 neto): emitida en septiembre, Por Emitir después. */
	const anaInvoice = (mm: string, overrides: Partial<ReturnType<typeof invoiceRow>> = {}) => {
		const base = invoiceRow(mm);

		return {
			...base,
			id: `ana-${mm}`,
			invoice_number: mm === '09' ? 'F-A09' : null,
			subtotal: 300,
			vat: 57,
			amount_invoice: 300,
			total_invoice: 357,
			lines: [
				{
					...base.lines[0],
					id: `line-${mm}-ana`,
					invoice_id: `ana-${mm}`,
					contract_item_id: ANALITICA,
					product_id: PRODUCT_NUEVO,
					description: `Analítica - Periodo 01/${mm}/2026 a ${LAST[mm]}/${mm}/2026`,
					quantity: 1,
					unit_price: 300,
					unit_price_invoice: 300,
					subtotal: 300,
					subtotal_invoice: 300,
					tax_amount: 57,
					tax_amount_invoice: 57,
					total: 357,
					total_invoice: 357,
				},
			],
			...overrides,
		};
	};
	const ninja = (september: Partial<ReturnType<typeof invoiceRow>> = { voided: true }) =>
		context({
			items: [itemRow(), soporteRow(), analitica()],
			invoices: [
				...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((mm) => invoiceRow(mm)),
				anaInvoice('09', september),
				anaInvoice('10'),
				anaInvoice('11'),
				anaInvoice('12'),
			],
		});
	const move = (ctx: ReturnType<typeof context>, start: string, extra: Record<string, unknown> = {}) =>
		planChange(
			ctx,
			request({ type: 'item_update', items: [{ item_id: ANALITICA, start_date: start, ...extra }] } as never, { effective_date: '2026-09-28' })
		);

	it('Ninja: la de septiembre anulada con NC (sin reemitir) → mover el inicio al 01-10 corrige el ítem en su lugar sin tocar facturas', () => {
		const plan = move(ninja(), '2026-10-01');

		expect(plan.preview.can_apply).toBe(true);
		expect(plan.preview.blockers).toEqual([]);
		expect(inserted(plan)).toEqual([]);
		expect(ops(plan, 'update_item')).toEqual([
			{ kind: 'update_item', item_id: ANALITICA, set: { start_date: '2026-10-01', term_months: 3, price: 900, final_price: 900 } },
		]);
		// Las Por Emitir de octubre en adelante ya parten el 01-10: nada que quitar ni generar; la anulada no se toca.
		expect([...ops(plan, 'delete_line'), ...ops(plan, 'create_invoices'), ...ops(plan, 'cancel_invoice')]).toEqual([]);
		expect(ops(plan, 'regenerate_descriptions')).toEqual([]);
		expect(plan.preview.contract.after.total_value).toBe(12000 + 2400 + 900);
		expect(plan.preview.rsm).toMatchObject({ first_month: '2026-09-01', momentum: 'ITEM_CORRECTED' });
		expect(plan.event).toMatchObject({
			type: 'ITEM_CORRECTED',
			subtype: 'start',
			amount_delta: 0,
			description: '"Analítica": fecha de inicio 2026-09-01 → 2026-10-01',
			metadata: expect.objectContaining({
				items: [
					{ item_id: ANALITICA, product_name: 'Analítica', changes: [{ field: 'start_date', before: '2026-09-01', after: '2026-10-01' }] },
				],
			}),
		});
	});

	it('bloquea si queda una emitida vigente del ítem antes del nuevo inicio: hay que anularla con NC primero', () => {
		const plan = move(ninja({}), '2026-10-01');

		expect(plan.preview.can_apply).toBe(false);
		expect(plan.preview.blockers).toEqual([
			{
				code: 'issued_invoice_before_start',
				message: 'Anula con nota de crédito la factura F-A09 antes de mover el inicio: cobra "Analítica" antes del 2026-10-01',
				next_step: 'Anúlala desde su vista rápida con una nota de crédito, sin reemitir, y vuelve a corregir la fecha',
			},
		]);
	});

	it('las Por Emitir del ítem antes del nuevo inicio se cancelan y el primer período queda prorrateado como al crear', () => {
		const plan = move(ninja(), '2026-10-15');

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'delete_line')).toEqual([{ kind: 'delete_line', invoice_id: 'ana-10', line_id: 'line-10-ana' }]);
		const [created] = ops(plan, 'create_invoices');
		const lines = created.invoices.flatMap((invoice: { lines: PreviewLine[] }) => invoice.lines);

		// 15-10 → 31-10: 17 de 31 días de 300; como al crear, el tramo inicial va con la factura del ciclo siguiente (PE de noviembre).
		expect(lines.map((line: PreviewLine) => [line.billing_period_start, line.billing_period_end, line.subtotal])).toEqual([
			['2026-10-15', '2026-10-31', 164.52],
		]);
		expect(created.merge_into).toEqual(['inv-11']);
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['ana-10']);
		expect(plan.preview.invoices.updated).toEqual([
			expect.objectContaining({
				id: 'inv-11',
				subtotal_before: 1200,
				subtotal_after: 1364.52,
				change: 'se suma el tramo del nuevo inicio a la factura del 2026-11-01',
			}),
		]);
		// Las Por Emitir propias de noviembre y diciembre siguen como estaban.
		expect(plan.ops.some((op) => 'invoice_id' in op && /ana-1[12]/.test(String(op.invoice_id)))).toBe(false);
	});

	it('adelantar el inicio genera la Por Emitir del tramo que falta (solo los días sin factura vigente)', () => {
		const ctx = context({
			items: [itemRow(), soporteRow(), analitica({ start_date: '2026-10-01', term_months: 3, price: 900, final_price: 900 })],
			invoices: [
				...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((mm) => invoiceRow(mm)),
				anaInvoice('10'),
				anaInvoice('11'),
				anaInvoice('12'),
			],
		});
		const plan = move(ctx, '2026-09-15');

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'update_item')[0].set).toMatchObject({ start_date: '2026-09-15', term_months: 4 });
		expect(ops(plan, 'delete_line')).toEqual([]);
		const [created] = ops(plan, 'create_invoices');

		// 15-09 → 30-09: 16 de 30 días de 300; el tramo inicial va con la factura del ciclo siguiente (como al crear) y se funde con la PE de octubre.
		expect(
			created.invoices.flatMap((invoice: { lines: PreviewLine[] }) =>
				invoice.lines.map((line) => [line.billing_period_start, line.billing_period_end, line.subtotal])
			)
		).toEqual([['2026-09-15', '2026-09-30', 160]]);
		expect(created.merge_into).toEqual(['inv-10']);
		expect(plan.preview.invoices.updated).toEqual([expect.objectContaining({ id: 'inv-10', subtotal_before: 1200, subtotal_after: 1360 })]);
		expect(plan.preview.contract.after.total_value).toBe(12000 + 2400 + 1060);
		expect(plan.preview.rsm.first_month).toBe('2026-09-01');
	});

	it('valida: fecha real, ≤ fin del ítem, sin cambiar el valor en el mismo paso y con el mes abierto', () => {
		expect(fields(() => move(ninja(), '2026-02-30'))).toEqual(['change.items.0.start_date']);
		expect(fields(() => move(ninja(), '2027-01-15'))).toEqual(['change.items.0.start_date']);
		expect(fields(() => move(ninja(), '2026-10-01', { quantity: 2 }))).toEqual(['change.items']);
		const closed = move({ ...ninja(), contract: contractRow({ cutoff_date: '2026-09-30' }) }, '2026-10-01');

		expect(closed.preview.blockers.map((blocker) => blocker.code)).toEqual(['period_closed']);
	});
});

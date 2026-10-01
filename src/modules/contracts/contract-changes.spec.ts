import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { CATALOG_PRICE_MESSAGES, type CatalogPrice } from './catalog-prices';
import { type ChangePlan, monthsCeil, planChange, taxRateFor, unifiedDelta, wholeMonths } from './contract-changes';
import {
	context,
	CONTRACT_ID,
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
			booking_date: '2026-11-15',
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
			{ mirrors_invoice_id: 'inv-09', mirrors_invoice_number: 'F-09', total: 634.66, currency: 'CLP', fx: 1 },
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

		expect(plan.preview.blockers.map((blocker) => blocker.code)).toEqual(['not_active']);
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
		// Fin del contrato = el más próximo de los vigentes no renovados (Soporte renovado hasta junio 2027).
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { total_value: 14400 + 13200, contract_end_date: '2027-06-30' },
			bypass_end_date_guard: true,
		});
		expect(plan.preview.contract.after).toMatchObject({ end_date: '2027-06-30', status: 'active' });
		expect(plan.event).toMatchObject({ type: 'RENEWAL', amount_delta: 0, items_affected: [LICENCIA, SOPORTE], rsm_from_month: '2027-01-01' });
		expect(plan.preview.warnings).toEqual([]);
	});
	it('renovación parcial no mueve el fin si el otro ítem sigue sin renovar; retroactiva avisa; Vencido se admite', () => {
		const expired = context({
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
		// Soporte venció y no se renovó: el fin más próximo es su 30-06 (el encabezado guardaba 31-12).
		expect(ops(plan, 'update_contract')[0]).toMatchObject({
			set: { total_value: 6000 + 1200 + 6000, contract_end_date: '2026-06-30' },
			bypass_end_date_guard: true,
		});
		expect(plan.preview.contract.after.status).toBe('pending_renewal');
	});
	it('rechaza cambio de precio (S3-15 pendiente), catch-up en el mes actual, fin no entero y bloquea ítems churneados o ya renovados', () => {
		expect(fields(() => planChange(context(), request({ type: 'renewal', items: [{ item_id: LICENCIA, unit_price: 120 }] })))).toEqual([
			'change.items.0.unit_price',
		]);
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
	it('bloquea si ya está facturado en firme después de la fecha (con fecha sugerida) y rechaza frecuencia, fin, sin cambio y 100 %', () => {
		const blocked = planChange(
			context(),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100 }] }, { effective_date: '2026-09-15' })
		);

		expect(blocked.preview.blockers[0]).toMatchObject({ code: 'issued_after_effective_date', next_step: expect.stringContaining('2026-10-01') });
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 100, billing_frequency: 'Anual' }] })
				)
			)
		).toEqual(['change.items.0.billing_frequency', 'change.items.0.quantity']);
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
	it('documento del catálogo: cambia la familia, el IVA de las PE futuras y se rechaza si no corresponde a la compañía; sin cambios → 400', () => {
		const plan = planChange(
			context({ tax_document_type: { id: 'tdt-110', code: '110', name: 'Factura de exportación electrónica', kind: 'export_invoice' } }),
			request({ type: 'billing_conditions', tax_document_type_id: 'tdt-110' }, { effective_date: '2026-11-01' })
		);

		expect(ops(plan, 'update_invoices_document')).toEqual([
			{
				kind: 'update_invoices_document',
				invoice_ids: ['inv-11', 'inv-12'],
				document_type: 'FACTURA_EXPORTACION',
				export_type: 1,
				tax_rate: 0,
			},
		]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({ set: { tax_document_type_id: 'tdt-110', document_type: 'FACTURA_EXPORTACION' } });
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', tax_document_type_id: 'tdt-x' })))).toEqual([
			'change.tax_document_type_id',
		]);
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', payment_terms: { kind: 'net', days: 30 } })))).toEqual([
			'change',
		]);
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
	it('reactivate, pause, resume y price_adjustment → 400 explicando qué falta decidir; items obligatorios en los tipos de ítems', () => {
		for (const type of ['reactivate', 'pause', 'resume', 'price_adjustment'] as const) {
			expect(fields(() => planChange(context(), request({ type })))).toEqual(['change.type']);
		}
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

	it('contract_cancel: bloquea con manual_lines_pending si una Por Emitir desde la fecha tiene líneas a mano; la facturada por OC se omite', () => {
		const manual = planChange(
			context({ invoices: withInvoice('inv-12', (invoice) => licenciaLine(invoice, { quantity_source: 'manual' })) }),
			request({ type: 'contract_cancel' }, { effective_date: '2026-12-01' })
		);

		expect(manual.preview.blockers).toContainEqual({
			code: 'manual_lines_pending',
			message: expect.stringContaining('editadas a mano'),
			next_step: 'Edita o cancela esas facturas primero',
		});
		expect(manual.preview.can_apply).toBe(false);
		const po = planChange(
			context({ invoices: withInvoice('inv-12', partial) }),
			request({ type: 'contract_cancel' }, { effective_date: '2026-12-01' })
		);

		expect(po.preview.invoices.cancelled).toEqual([]);
		expect(ops(po, 'delete_line')).toEqual([]);
		expect(codes(po)).toContain('partial_billing_skipped');
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
	});
});

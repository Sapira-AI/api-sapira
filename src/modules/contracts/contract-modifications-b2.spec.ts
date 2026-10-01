// `contract-activation.service` → `InvoiceSchedulerService` importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

/**
 * Bloque Modificaciones B2 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §9): cancelación con decisiones por factura (9.3.1), razón
 * social nueva (9.3.10), renovación con precio, pactos y extensión de FX (9.3.4), cambio de frecuencia o plazo (9.3.7), ajustes pactados
 * (9.3.6), reactivar (9.3.2), ciclo propio por ítem (9.3.9) y el flujo cotización → contrato. Los casos con código S… son los de soporte de
 * `docs/v2-rediseno/auditoria-contratos.md`.
 *
 * Fixture (`contract-changes.test-fixtures.ts`): contrato CLP, IVA 19, ciclo día 1, Licencia 10 × 100 y Soporte 1 × 200 de ene a dic 2026,
 * emitidas ene–sep, Por Emitir oct–dic. Hoy = 28-09-2026.
 */
import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { defaultAnchorDay, generateInvoices } from './billing-engine';
import { ContractActivationService } from './contract-activation.service';
import {
	blockedPreview,
	type ChangeContext,
	type ChangeInvoiceRow,
	type ChangePlan,
	normalizeTaxId,
	planChange,
	type QuoteItemRow,
	type ScheduledChangeRow,
} from './contract-changes';
import {
	context,
	contractRow,
	invoiceRow,
	itemRow,
	LICENCIA,
	PRODUCT_LICENCIA,
	PRODUCT_NUEVO,
	request,
	SOPORTE,
	soporteRow,
} from './contract-changes.test-fixtures';
import { draftScheduledChangeErrors, nextEffectiveOf, scheduledChangeErrors } from './scheduled-change-rows';
import { currentItemOf, pactApplication } from './scheduled-changes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const inserted = (plan: ChangePlan) => ops(plan, 'insert_item').map((op) => (op as { item: Record<string, unknown> }).item);
const codes = (plan: ChangePlan) => plan.preview.warnings.map((warning) => warning.code);
const blockers = (plan: ChangePlan) => plan.preview.blockers.map((blocker) => blocker.code);
const fields = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(BadRequestException);

		return fieldErrorsOf(error)!.map((entry) => entry.field);
	}
	throw new Error('se esperaba un 400');
};
const pact = (overrides: Partial<ScheduledChangeRow> = {}): ScheduledChangeRow => ({
	id: 'pact-1',
	contract_item_id: LICENCIA,
	group_key: null,
	parent_id: null,
	trigger: 'on_renewal',
	effective_date: null,
	anchor_date: null,
	interval_months: null,
	next_effective_date: null,
	kind: 'percent_uplift',
	value: 5,
	index_code: null,
	index_base_date: null,
	index_base_value: null,
	index_lag_months: 1,
	rounding: 'unit_2',
	status: 'scheduled',
	...overrides,
});

// ------------------------------------------------------------------ 9.3.1 contract_cancel con decisiones por factura

describe('contract_cancel con decisiones por factura (§9.3.1, S2-8)', () => {
	it('lista las Por Emitir desde la fecha con su monto, opciones y default; sin decisión → blocker invoice_decision_required', () => {
		const plan = planChange(context(), request({ type: 'contract_cancel' }));

		expect(plan.preview.invoice_decisions_required).toEqual([
			expect.objectContaining({
				invoice_id: 'inv-11',
				status_group: 'pending',
				amount_after_effective: 640,
				options: ['emit', 'cancel'],
				default: 'cancel',
				action: 'cancel',
			}),
			expect.objectContaining({ invoice_id: 'inv-12', status_group: 'pending', amount_after_effective: 1200, action: 'cancel' }),
		]);
		expect(blockers(plan)).toEqual(['invoice_decision_required']);
		expect(plan.preview.blockers[0].next_step).toContain('invoice_decisions');
		// Con los defaults el cálculo es la regla actual: noviembre prorrateado (15/30) y diciembre cancelada.
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(plan.preview.invoices.updated.map((invoice) => invoice.id)).toEqual(['inv-11']);
	});

	it('matriz: emit deja la Por Emitir completa (aviso billed_beyond_effective_date) y cancel aplica la regla; queda en el evento', () => {
		const plan = planChange(
			context(),
			request({
				type: 'contract_cancel',
				invoice_decisions: [
					{ invoice_id: 'inv-11', action: 'emit' },
					{ invoice_id: 'inv-12', action: 'cancel' },
				],
			})
		);

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'update_line').filter((op) => op.invoice_id === 'inv-11')).toEqual([]);
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(codes(plan)).toContain('billed_beyond_effective_date');
		expect(plan.event.metadata.invoice_decisions).toEqual([
			expect.objectContaining({ invoice_id: 'inv-11', action: 'emit', defaulted: false }),
			expect.objectContaining({ invoice_id: 'inv-12', action: 'cancel', defaulted: false }),
		]);
	});

	it('emitida con período desde la fecha: void emite la NC proporcional; keep la conserva sin NC (S4-1)', () => {
		const base = { effective_date: '2026-09-16' };
		const required = planChange(context(), request({ type: 'contract_cancel' }, base)).preview.invoice_decisions_required!;

		expect(required.find((entry) => entry.invoice_id === 'inv-09')).toMatchObject({
			status_group: 'issued',
			options: ['keep', 'void'],
			default: 'void',
			amount_after_effective: 600,
		});
		const decisions = required.map((entry) => ({ invoice_id: entry.invoice_id, action: entry.default }));
		const voided = planChange(context(), request({ type: 'contract_cancel', invoice_decisions: decisions }, base));

		// Una NC espejo por ítem cancelado sobre la emitida (regla de la baja, sin cambios).
		expect(ops(voided, 'credit_note').map((op) => op.mirrors.id)).toEqual(['inv-09', 'inv-09']);
		const kept = planChange(
			context(),
			request(
				{
					type: 'contract_cancel',
					invoice_decisions: decisions.map((entry) => (entry.invoice_id === 'inv-09' ? { ...entry, action: 'keep' as const } : entry)),
				},
				base
			)
		);

		expect(ops(kept, 'credit_note')).toEqual([]);
		expect(codes(kept)).toContain('billed_beyond_effective_date');
	});

	it('400 por decisión ajena o que no corresponde al estado de la factura', () => {
		expect(
			fields(() =>
				planChange(
					context(),
					request({
						type: 'contract_cancel',
						invoice_decisions: [
							{ invoice_id: 'inv-11', action: 'void' },
							{ invoice_id: 'inv-03', action: 'cancel' },
						],
					})
				)
			)
		).toEqual(['change.invoice_decisions.0.action', 'change.invoice_decisions.1.invoice_id']);
	});

	it('sugiere fechas para ajustar: fin del último período emitido (sin NC) y fin del período en curso', () => {
		const plan = planChange(context(), request({ type: 'contract_cancel' }, { effective_date: '2026-09-16' }));

		expect(plan.preview.effective_date_suggestions).toEqual([
			{ effective_date: '2026-10-01', reason: 'last_issued_period', message: expect.stringContaining('2026-09-30') },
		]);
		// Con la fecha sugerida no queda emitida que decidir (sin NC).
		const suggested = planChange(context(), request({ type: 'contract_cancel' }, { effective_date: '2026-10-01' }));

		expect(suggested.preview.invoice_decisions_required!.every((entry) => entry.status_group === 'pending')).toBe(true);
		expect(suggested.preview.effective_date_suggestions).toEqual([]);
	});
});

// ------------------------------------------------------------------ 9.3.10 change_entity con razón social nueva

describe('change_entity con new_entity (§9.3.10)', () => {
	const newEntity = { legal_name: 'Cliente Norte SpA', tax_id: '76.543.210-K', country: 'Chile' };

	it('no existe en el holding → se crea ligada al cliente y el contrato y las PE la toman (clave temporal)', () => {
		const plan = planChange(context(), request({ type: 'change_entity', new_entity: newEntity }));

		expect(ops(plan, 'insert_entity')[0].entity).toMatchObject({
			client_id: 'client-1',
			legal_name: 'Cliente Norte SpA',
			tax_id: '76.543.210-K',
		});
		expect(ops(plan, 'update_contract')[0].set.client_entity_id).toBe('new:entity');
		expect(ops(plan, 'update_invoices_fields')[0].set.client_entity_id).toBe('new:entity');
		expect(plan.event).toMatchObject({ type: 'ENTITY_CHANGED', metadata: expect.objectContaining({ entity_created: true }) });
	});

	it('existe y es del cliente → se usa con aviso entity_already_exists; de otro cliente → blocker entity_belongs_to_other_client', () => {
		const existing = { id: 'entity-9', legal_name: 'Cliente Norte SpA', tax_id: '76543210-k', country: 'Chile', belongs_to_client: true };
		const reused = planChange(context({ entity_lookup: existing }), request({ type: 'change_entity', new_entity: newEntity }));

		expect(ops(reused, 'insert_entity')).toEqual([]);
		expect(ops(reused, 'update_contract')[0].set.client_entity_id).toBe('entity-9');
		expect(codes(reused)).toContain('entity_already_exists');
		expect(reused.event.metadata.entity_created).toBe(false);
		const other = planChange(
			context({ entity_lookup: { ...existing, belongs_to_client: false } }),
			request({ type: 'change_entity', new_entity: newEntity })
		);

		expect(blockers(other)).toEqual(['entity_belongs_to_other_client']);
	});

	it('400 con client_entity_id y new_entity a la vez; identificador normalizado como el directorio de clientes', () => {
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'change_entity', client_entity_id: 'e0000000-0000-4000-8000-000000000002', new_entity: newEntity })
				)
			)
		).toEqual(['change.new_entity']);
		expect(normalizeTaxId('76.543.210-K')).toBe('76543210k');
	});
});

// ------------------------------------------------------------------ 9.3.4 renovación con precio, pactos y FX

describe('renewal con precio nuevo (§9.3.4, S3-15: dos ítems explícitos)', () => {
	it('unitario nuevo → RENEWAL al valor vigente + UPSELL ligado al RENEWAL, pacto on_renewal applied y línea neta en las facturas', () => {
		const plan = planChange(context(), request({ type: 'renewal', items: [{ item_id: LICENCIA, unit_price: 120 }] }, { reason: 'ok' }));
		const [renewal, adjustment] = inserted(plan);

		expect(renewal).toMatchObject({ categoria: 'RENEWAL', quantity: 10, unit_price: 100, start_date: '2027-01-01', end_date: '2027-12-31' });
		expect(adjustment).toMatchObject({
			categoria: 'UPSELL',
			related_item_id: renewal.key,
			quantity: 10,
			unit_price: 20,
			start_date: '2027-01-01',
			end_date: '2027-12-31',
			final_price: 2400,
		});
		expect(ops(plan, 'insert_scheduled_change')[0].row).toMatchObject({
			contract_item_ref: LICENCIA,
			trigger: 'on_renewal',
			kind: 'new_unit_price',
			value: 120,
			status: 'applied',
			applied_value: 120,
		});
		// Facturas: una línea por período al valor renovado (1.200), ligada al RENEWAL.
		const lines = plan.preview.invoices.created.flatMap((invoice) => invoice.lines);

		expect(new Set(lines.map((line) => line.item_key))).toEqual(new Set([renewal.key]));
		expect(lines[0].subtotal).toBe(1200);
		expect(plan.event).toMatchObject({ type: 'RENEWAL', subtype: 'price_change', amount_delta: 200 });
	});

	it('cantidad menor → DOWNSELL del ajuste; sin cambios sigue siendo la renovación al mismo precio', () => {
		const plan = planChange(context(), request({ type: 'renewal', items: [{ item_id: LICENCIA, quantity: 8 }] }, { reason: 'ok' }));

		expect(inserted(plan).map((item) => item.categoria)).toEqual(['RENEWAL', 'DOWNSELL']);
		expect(plan.event.amount_delta).toBe(-200);
		const same = planChange(context(), request({ type: 'renewal', items: [{ item_id: LICENCIA, unit_price: 100 }] }));

		expect(inserted(same).map((item) => item.categoria)).toEqual(['RENEWAL']);
		expect(ops(same, 'insert_scheduled_change')).toEqual([]);
	});

	it('pactos on_renewal del ítem y del contrato se aplican en el mismo acto; omitir exige motivo (skipped)', () => {
		const ctx = context({
			scheduled_changes: [pact(), pact({ id: 'pact-2', contract_item_id: null, kind: 'term', value: 24 })],
		});
		const plan = planChange(ctx, request({ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] }, { reason: 'ok' }));
		const renewals = inserted(plan).filter((item) => item.categoria === 'RENEWAL');

		expect(renewals.map((item) => [item.product_name, item.term_months, item.end_date])).toEqual([
			['Licencia', 24, '2028-12-31'],
			['Soporte', 24, '2028-12-31'],
		]);
		expect(inserted(plan).find((item) => item.categoria === 'UPSELL')).toMatchObject({ unit_price: 5, quantity: 10 });
		// Un pacto de alcance contrato se marca una sola vez aunque alcance a los dos ítems.
		expect(ops(plan, 'update_scheduled_change').map((op) => [op.id, op.set.status, op.set.applied_value])).toEqual([
			['pact-1', 'applied', 5],
			['pact-2', 'applied', 24],
		]);
		const skipped = planChange(
			ctx,
			request(
				{
					type: 'renewal',
					items: [{ item_id: LICENCIA }],
					scheduled_change_decisions: [{ scheduled_change_id: 'pact-1', action: 'skip', reason: 'Se negoció mantener el precio' }],
				},
				{ reason: 'ok' }
			)
		);

		expect(ops(skipped, 'update_scheduled_change')[0]).toMatchObject({ id: 'pact-1', set: { status: 'skipped' } });
		expect(inserted(skipped).map((item) => item.categoria)).toEqual(['RENEWAL']);
		expect(
			fields(() =>
				planChange(
					ctx,
					request({
						type: 'renewal',
						items: [{ item_id: LICENCIA }],
						scheduled_change_decisions: [{ scheduled_change_id: 'pact-1', action: 'skip' }],
					})
				)
			)
		).toEqual(['change.scheduled_change_decisions.0.reason']);
	});

	it('pacto por índice: sin dato publicado → blocker index_value_missing; con serie aplica la variación (+ puntos) y la guarda', () => {
		const indexPact = pact({ kind: 'index', index_code: 'IPC', index_base_value: 100, value: 0 });
		const missing = planChange(context({ scheduled_changes: [indexPact] }), request({ type: 'renewal', items: [{ item_id: LICENCIA }] }));

		expect(blockers(missing)).toEqual(['index_value_missing']);
		const withSeries = planChange(
			context({ scheduled_changes: [indexPact], index_series: new Map([['IPC', [{ date: '2026-11-30', value: 104 }]]]) }),
			request({ type: 'renewal', items: [{ item_id: LICENCIA }] }, { reason: 'ok' })
		);

		expect(inserted(withSeries)[1]).toMatchObject({ categoria: 'UPSELL', unit_price: 4 });
		expect(ops(withSeries, 'update_scheduled_change')[0].set).toMatchObject({ status: 'applied', applied_value: 4 });
	});
});

describe('renewal: extensión de tasas de todo el contrato (§9.3.4, spec multimoneda §6)', () => {
	const usdContract = (rates: Array<{ id: string; start: string; end: string }>) =>
		contractRow({
			invoice_currency: 'USD',
			fx_invoice_policy: 'fixed',
			fx_invoice_rates: rates.map((rate) => ({
				from_currency: 'CLP',
				to_currency: 'USD',
				rate: 0.001,
				period_start: rate.start,
				period_end: rate.end,
			})),
			fx_rates: rates.map((rate) => ({
				id: rate.id,
				purpose: 'invoice' as const,
				from_currency: 'CLP',
				to_currency: 'USD',
				rate: 0.001,
				period_start: rate.start,
				period_end: rate.end,
			})),
		});

	it('tasa única que cubría todo el contrato → extend_fx_rates al nuevo fin con aviso fx_rate_extended (sin bloqueo)', () => {
		const plan = planChange(
			context({ contract: usdContract([{ id: 'rate-1', start: '2026-01-01', end: '2026-12-31' }]) }),
			request({ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] }, { reason: 'ok' })
		);

		expect(ops(plan, 'extend_fx_rates')).toEqual([{ kind: 'extend_fx_rates', rates: [{ id: 'rate-1', period_end: '2027-12-31' }] }]);
		expect(plan.preview.fx_rates_extended).toEqual([
			expect.objectContaining({ id: 'rate-1', purpose: 'invoice', from_currency: 'CLP', to_currency: 'USD', period_end_after: '2027-12-31' }),
		]);
		expect(codes(plan)).toContain('fx_rate_extended');
		expect(blockers(plan)).not.toContain('fixed_fx_without_rate');
	});

	it('tasas por período sin cobertura del nuevo término → fixed_fx_without_rate con el par; con tasa nueva en el pedido no se extiende', () => {
		const periods = usdContract([
			{ id: 'rate-1', start: '2026-01-01', end: '2026-06-30' },
			{ id: 'rate-2', start: '2026-07-01', end: '2026-12-31' },
		]);
		const plan = planChange(context({ contract: periods }), request({ type: 'renewal', items: [{ item_id: LICENCIA }] }));

		expect(ops(plan, 'extend_fx_rates')).toEqual([]);
		expect(plan.preview.blockers.find((blocker) => blocker.code === 'fixed_fx_without_rate')?.message).toContain('CLP → USD');
		const sent = planChange(
			context({ contract: usdContract([{ id: 'rate-1', start: '2026-01-01', end: '2026-12-31' }]) }),
			request(
				{
					type: 'renewal',
					items: [{ item_id: LICENCIA }, { item_id: SOPORTE }],
					fx_invoice_rates: [{ rate: 0.0011, period_start: '2027-01-01', period_end: '2027-12-31' }],
				},
				{ reason: 'ok' }
			)
		);

		expect(ops(sent, 'extend_fx_rates')).toEqual([]);
		expect(ops(sent, 'insert_fx_rates')[0].rates).toEqual([expect.objectContaining({ purpose: 'invoice', from_currency: 'CLP', rate: 0.0011 })]);
	});
});

// ------------------------------------------------------------------ 9.3.7 frecuencia o término

describe('item_change con frecuencia o plazo (§9.3.7, S3-15)', () => {
	it('frecuencia nueva: corte al próximo inicio de período, RENEWAL Anual al mismo mensual, pacto applied y PE del original sin su línea', () => {
		const plan = planChange(
			context(),
			request(
				{ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 100, billing_frequency: 'Anual', term_months: 12 }] },
				{ reason: 'ok' }
			)
		);
		const [renewal] = inserted(plan);

		expect(renewal).toMatchObject({
			categoria: 'RENEWAL',
			renews_item_id: LICENCIA,
			billing_frequency: 'Anual',
			start_date: '2026-12-01',
			end_date: '2027-11-30',
			term_months: 12,
			quantity: 10,
			unit_price: 100,
		});
		expect(ops(plan, 'update_item')[0]).toMatchObject({
			item_id: LICENCIA,
			set: { end_date: '2026-11-30', term_months: 11, final_price: 11000, renewed_by_key: renewal.key },
		});
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-12-lic']);
		expect(ops(plan, 'insert_scheduled_change').map((op) => [op.row.kind, op.row.value, op.row.status, op.row.effective_date])).toEqual([
			['billing_frequency', 12, 'applied', '2026-12-01'],
			['term', 12, 'applied', '2026-12-01'],
		]);
		// Una cuota anual que parte el 01-12 (12 × 1.000) se suma a la PE de diciembre (F3), que pierde la línea mensual de la Licencia.
		const [created] = ops(plan, 'create_invoices');

		expect(created.invoices.map((invoice: { issue_date: string; subtotal: number }) => [invoice.issue_date, invoice.subtotal])).toEqual([
			['2026-12-01', 12000],
		]);
		expect(created.merge_into).toEqual(['inv-12']);
		expect(plan.preview.invoices.updated.find((invoice) => invoice.id === 'inv-12')?.subtotal_after).toBe(12200);
		expect(plan.event).toMatchObject({
			type: 'RENEWAL',
			subtype: 'RENEGOTIATION',
			metadata: expect.objectContaining({
				reterm: { frequency_before: 'Mensual', frequency_after: 'Anual', term_before: 12, term_after: 12, cut: '2026-12-01' },
			}),
		});
	});

	it('plazo con precio nuevo → RENEWAL + UPSELL de ajuste; emitida después del corte → issued_after_effective_date con fecha', () => {
		const plan = planChange(
			context(),
			request({ type: 'item_change', items: [{ item_id: SOPORTE, quantity: 1, unit_price: 250, term_months: 24 }] }, { reason: 'ok' })
		);

		expect(inserted(plan).map((item) => [item.categoria, item.term_months])).toEqual([
			['RENEWAL', 24],
			['UPSELL', 24],
		]);
		expect(plan.event).toMatchObject({ type: 'UPSELL', subtype: 'RENEGOTIATION', amount_delta: 50 });
		const issued = planChange(
			context({
				invoices: [
					...context().invoices.filter((row) => row.id !== 'inv-12'),
					invoiceRow('12', { status: 'Emitida', invoice_number: 'F-12' }),
				],
			}),
			request({ type: 'item_change', items: [{ item_id: SOPORTE, quantity: 1, unit_price: 200, term_months: 24 }] })
		);

		expect(issued.preview.blockers[0]).toMatchObject({ code: 'issued_after_effective_date', next_step: expect.stringContaining('2027-01-01') });
	});
});

// ------------------------------------------------------------------ 9.3.6 ajustes pactados (R1)

describe('ajustes pactados: reglas y materialización (§9.3.6, S1-18)', () => {
	it('valida campos por disparo y tipo; on_date/every_n_months fijan la próxima fecha; el alta resuelve item_key', () => {
		expect(
			scheduledChangeErrors({ trigger: 'on_date', kind: 'percent_uplift', value: 5 }, 'body', null, false).map((error) => error.field)
		).toEqual(['body.effective_date']);
		expect(
			scheduledChangeErrors({ trigger: 'every_n_months', kind: 'index', value: 0 }, 'body', null, false).map((error) => error.field)
		).toEqual(['body.anchor_date', 'body.interval_months', 'body.index_code', 'body.index_base_value']);
		expect(
			scheduledChangeErrors({ trigger: 'on_renewal', kind: 'billing_frequency', value: 5 }, 'body', null, false).map((error) => error.field)
		).toEqual(['body.value']);
		expect(nextEffectiveOf({ trigger: 'every_n_months', anchor_date: '2027-01-01' })).toBe('2027-01-01');
		expect(nextEffectiveOf({ trigger: 'on_renewal' })).toBeNull();
		expect(
			draftScheduledChangeErrors(
				[
					{ item_key: 'item-1', trigger: 'on_renewal', kind: 'percent_uplift', value: 5 },
					{ item_key: 'otro', trigger: 'on_renewal', kind: 'percent_uplift', value: 5 },
				],
				[{ key: 'item-1', product_name: 'Licencia', is_recurring: true }]
			).map((error) => error.field)
		).toEqual(['scheduled_changes.1.contract_item_id']);
	});

	it('on_date % → item_change desde el próximo inicio de período (sin prorrateo), pacto applied, evento UPSELL subtipo price_step', () => {
		const row = pact({ trigger: 'on_date', effective_date: '2026-11-15', next_effective_date: '2026-11-15' });
		const ctx = context({ scheduled_changes: [row] });
		const application = pactApplication(ctx, row, {});

		expect(application.request).toMatchObject({
			effective_date: '2026-12-01',
			change: { type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 105 }] },
		});
		const plan = planChange(ctx, application.request, application.options);

		expect(inserted(plan)[0]).toMatchObject({ categoria: 'UPSELL', start_date: '2026-12-01', unit_price: 5 });
		expect(ops(plan, 'update_scheduled_change')).toEqual([
			{ kind: 'update_scheduled_change', id: 'pact-1', set: { status: 'applied', applied_value: 5 } },
		]);
		expect(plan.event).toMatchObject({
			type: 'UPSELL',
			subtype: 'price_step',
			metadata: expect.objectContaining({ scheduled_change_id: 'pact-1' }),
		});
	});

	it('every_n_months → hija applied y la madre avanza un intervalo; on_renewal → renewal; índice sin dato → blocker en el preview', () => {
		const yearly = pact({
			trigger: 'every_n_months',
			anchor_date: '2026-12-01',
			interval_months: 12,
			next_effective_date: '2026-12-01',
			kind: 'new_unit_price',
			value: 110,
		});
		const ctx = context({ scheduled_changes: [yearly] });
		const application = pactApplication(ctx, yearly, {});
		const plan = planChange(ctx, application.request, application.options);

		expect(ops(plan, 'insert_scheduled_change')[0].row).toMatchObject({
			parent_id: 'pact-1',
			status: 'applied',
			applied_value: 110,
			effective_date: '2026-12-01',
		});
		expect(ops(plan, 'update_scheduled_change')[0]).toMatchObject({ id: 'pact-1', set: { next_effective_date: '2027-12-01' } });
		expect(pactApplication(ctx, pact(), {}).request.change).toEqual({ type: 'renewal', items: [{ item_id: LICENCIA }] });
		const indexed = pact({ trigger: 'on_date', effective_date: '2026-12-01', kind: 'index', index_code: 'UF', index_base_value: 39000 });
		const blocked = pactApplication(context({ scheduled_changes: [indexed] }), indexed, {});

		expect(blocked.blockers.map((blocker) => blocker.code)).toEqual(['index_value_missing']);
		expect(blockedPreview(context(), blocked.request, blocked.blockers).can_apply).toBe(false);
	});

	it('un pacto ya aplicado no se vuelve a aplicar (scheduled_change_not_scheduled); el ítem renovado se sigue por renewed_by', () => {
		const applied = pact({ trigger: 'on_date', effective_date: '2026-11-15', status: 'applied' });
		const ctx = context({ scheduled_changes: [applied] });
		const application = pactApplication(ctx, { ...applied, status: 'scheduled' }, {});

		expect(blockers(planChange(ctx, application.request, application.options))).toContain('scheduled_change_not_scheduled');
		const items = [itemRow({ renewed_by_item_id: 'renewal-1' }), itemRow({ id: 'renewal-1', categoria: 'RENEWAL', renews_item_id: LICENCIA })];

		expect(currentItemOf(items, LICENCIA)?.id).toBe('renewal-1');
	});

	it('la baja de un ítem cancela sus pactos programados (status_reason item_ended)', () => {
		const plan = planChange(
			context({ scheduled_changes: [pact({ trigger: 'on_date', effective_date: '2026-12-01' })] }),
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] })
		);

		expect(ops(plan, 'update_scheduled_change')).toEqual([
			{ kind: 'update_scheduled_change', id: 'pact-1', set: { status: 'cancelled', status_reason: 'item_ended' } },
		]);
	});
});

// ------------------------------------------------------------------ 9.3.2 reactivar

describe('reactivate (§9.3.2, S2-8 / S3-9 / S5-7)', () => {
	/** Contrato cancelado al `churn`: ítems con baja, espejos CHURN, PE desde la fecha canceladas y el evento de la cancelación. */
	const cancelled = (churn: string, overrides: Partial<ChangeContext> = {}): ChangeContext => {
		const base = context();
		const mirror = (id: string, related: string, monthly: number) =>
			itemRow({
				id,
				related_item_id: related,
				categoria: 'CHURN',
				start_date: churn,
				end_date: '2026-12-31',
				monthly_price: -monthly,
				final_price: -monthly,
				quantity: 1,
				unit_price: -monthly,
			});

		return context({
			contract: contractRow({ status: 'Cancelado', churn_date: churn }),
			items: [
				itemRow({ churn_date: churn }),
				soporteRow({ churn_date: churn }),
				mirror('mirror-lic', LICENCIA, 1000),
				mirror('mirror-sop', SOPORTE, 200),
			],
			invoices: base.invoices.map((invoice) => ((invoice.issue_date ?? '') >= churn ? { ...invoice, status: 'Cancelada' } : invoice)),
			churn_events: [{ id: 'event-churn', event_type: 'CHURN', items_affected: [LICENCIA, SOPORTE], effective_date: churn, reversed: false }],
			...overrides,
		});
	};

	it('(a) churn aún no vigente → anular: quita los espejos, limpia churn, rehace las PE, vuelve a Activo y marca el evento original', () => {
		const plan = planChange(cancelled('2026-12-01'), request({ type: 'reactivate' }, { effective_date: '2026-10-01', reason: 'ok' }));

		expect(plan.preview.reactivation).toEqual([
			{ item_id: LICENCIA, branch: 'annul', churn_date: '2026-12-01', mirror_item_id: 'mirror-lic' },
			{ item_id: SOPORTE, branch: 'annul', churn_date: '2026-12-01', mirror_item_id: 'mirror-sop' },
		]);
		expect(ops(plan, 'delete_item').map((op) => op.item_id)).toEqual(['mirror-lic', 'mirror-sop']);
		expect(ops(plan, 'update_item').map((op) => op.set)).toEqual([
			{ churn_date: null, churn_monthly_amount: null },
			{ churn_date: null, churn_monthly_amount: null },
		]);
		expect(plan.preview.invoices.created.map((invoice) => [invoice.issue_date, invoice.subtotal])).toEqual([['2026-12-01', 1200]]);
		expect(ops(plan, 'update_contract')[0].set).toMatchObject({ status: 'Activo', churn_date: null, churn_reason_id: null });
		expect(ops(plan, 'mark_events_reversed')).toEqual([{ kind: 'mark_events_reversed', event_ids: ['event-churn'] }]);
		expect(plan.event).toMatchObject({ type: 'CHURN_REVERSED', subtype: 'annul', amount_delta: 1200 });
		expect(plan.preview.contract.after.status).toBe('active');
	});

	it('(b) vigente en mes abierto → revertir: cancela la NC Por Emitir, la NC emitida queda (aviso) y su tramo vuelve a facturarse', () => {
		const ncLine = (invoice: ChangeInvoiceRow, id: string) => ({
			...invoiceRow('09').lines[0],
			id,
			invoice_id: invoice.id,
			subtotal: -533.33,
			billing_period_start: '2026-09-15',
			billing_period_end: '2026-09-30',
		});
		const ncPending: ChangeInvoiceRow = {
			...invoiceRow('09'),
			id: 'nc-1',
			document_type: 'NC',
			status: 'Por Emitir',
			invoice_number: null,
			lines: [],
		};

		ncPending.lines = [ncLine(ncPending, 'nc-1-lic')];
		const ncIssued: ChangeInvoiceRow = {
			...invoiceRow('09'),
			id: 'nc-2',
			document_type: 'NC',
			status: 'Emitida',
			invoice_number: 'NC-2',
			lines: [],
		};

		ncIssued.lines = [{ ...ncLine(ncIssued, 'nc-2-sop'), contract_item_id: SOPORTE }];
		const ctx = cancelled('2026-09-15');
		const plan = planChange(
			{ ...ctx, invoices: [...ctx.invoices, ncPending, ncIssued] },
			request({ type: 'reactivate' }, { effective_date: '2026-09-28', reason: 'ok' })
		);

		expect(plan.preview.reactivation!.map((entry) => entry.branch)).toEqual(['revert', 'revert']);
		expect(ops(plan, 'cancel_invoice').map((op) => op.invoice_id)).toEqual(['nc-1']);
		expect(codes(plan)).toContain('credit_notes_issued_kept');
		// Soporte: la NC emitida descubrió 15–30 sep → línea proporcional (16/30 × 200); oct–dic completas para ambos.
		const lines = plan.preview.invoices.created.flatMap((invoice) => invoice.lines);

		expect(lines.filter((line) => line.billing_period_start === '2026-09-15').map((line) => [line.item_key, line.subtotal])).toEqual([
			[SOPORTE, 106.67],
		]);
		expect(lines.filter((line) => line.billing_period_start >= '2026-10-01')).toHaveLength(6);
		expect(plan.event.type).toBe('CHURN_REVERSED');
	});

	it('(c) mes cerrado → REACTIVATION nuevo desde la fecha efectiva al valor anterior; con otro contrato vigente del cliente es UPSELL', () => {
		const closed = cancelled('2026-09-15', {
			contract: contractRow({ status: 'Cancelado', churn_date: '2026-09-15', cutoff_date: '2026-09-30' }),
		});
		const plan = planChange(
			closed,
			request({ type: 'reactivate', items: [{ item_id: LICENCIA, unit_price: 110 }] }, { effective_date: '2026-10-01', reason: 'ok' })
		);

		expect(inserted(plan)[0]).toMatchObject({
			categoria: 'REACTIVATION',
			related_item_id: LICENCIA,
			start_date: '2026-10-01',
			end_date: '2026-12-31',
			quantity: 10,
			unit_price: 110,
		});
		expect(ops(plan, 'delete_item')).toEqual([]);
		expect(plan.event).toMatchObject({ type: 'REACTIVATION', subtype: 'reactivation', amount_delta: 1100 });
		const mixed = planChange(
			{ ...closed, client_contracts: [{ status: 'Activo', churn_date: null, product_ids: [PRODUCT_NUEVO] }] },
			request({ type: 'reactivate', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-10-01', reason: 'ok' })
		);

		expect(inserted(mixed)[0].categoria).toBe('UPSELL');
		const inClosed = planChange(closed, request({ type: 'reactivate', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-20' }));

		expect(blockers(inClosed)).toContain('period_closed');
	});

	it('not_cancelled: contrato vigente sin lista o ítem sin baja', () => {
		expect(blockers(planChange(context(), request({ type: 'reactivate' })))).toEqual(['not_cancelled']);
		expect(blockers(planChange(context(), request({ type: 'reactivate', items: [{ item_id: LICENCIA }] })))).toEqual(['not_cancelled']);
	});
});

// ------------------------------------------------------------------ 9.3.9 ciclo propio por ítem

describe('ciclo propio por ítem (§9.3.9, S3-16 / S3-17)', () => {
	const engineContract = { billing_anchor_day: 1, contract_currency: 'CLP', company: { country: 'Chile', tax_rate: 19 } };
	const engineItem = (overrides: Record<string, unknown> = {}) => ({
		key: 'own',
		product_name: 'Analítica',
		quantity: 1,
		unit_price: 300,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		start_date: '2026-10-15',
		term_months: 3,
		is_recurring: true,
		billing_anchor_day: 15,
		...overrides,
	});

	it('motor: el ítem de ciclo propio parte su día, sin tramo prorrateado, y emite en su propia fecha (agrupa por fecha exacta)', () => {
		const output = generateInvoices({
			contract: engineContract,
			items: [engineItem(), engineItem({ key: 'base', billing_anchor_day: null, start_date: '2026-10-01', unit_price: 100 })],
		});

		expect(output.invoices.map((invoice) => [invoice.issue_date, invoice.lines.map((line) => line.item_key)])).toEqual([
			['2026-10-01', ['base']],
			['2026-10-15', ['own']],
			['2026-11-01', ['base']],
			['2026-11-15', ['own']],
			['2026-12-01', ['base']],
			['2026-12-15', ['own']],
		]);
		expect(output.invoices.filter((invoice) => invoice.lines[0].item_key === 'own').every((invoice) => invoice.subtotal === 300)).toBe(true);
		expect(output.warning_codes).not.toContain('prorated_period');
		// Los ítems de ciclo propio no fijan el día de ciclo del contrato.
		expect(defaultAnchorDay([engineItem(), engineItem({ billing_anchor_day: null, start_date: '2026-10-03' })])).toBe(3);
	});

	it('activación: el ítem guardado con billing_anchor_day lo pasa al generador (NULL = ciclo del contrato)', () => {
		const row = {
			id: 'i-1',
			product_name: 'Analítica',
			quantity: '1',
			unit_price: '300',
			start_date: '2026-10-15',
			term_months: 3,
			is_recurring: true,
		};

		expect(ContractActivationService.engineItem({ ...row, billing_anchor_day: 15 }).billing_anchor_day).toBe(15);
		expect(ContractActivationService.engineItem({ ...row, billing_anchor_day: null }).billing_anchor_day).toBeUndefined();
	});

	it('item_add own: día de ciclo = día de inicio, valor por meses enteros, facturas propias que no se funden con las del ciclo del contrato', () => {
		const plan = planChange(
			context({ products: new Map([[PRODUCT_NUEVO, 'Analítica']]) }),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 300, billing_cycle: 'own' }] },
				{ reason: 'ok' }
			)
		);

		expect(inserted(plan)[0]).toMatchObject({ billing_anchor_day: 15, start_date: '2026-11-15', end_date: '2026-12-31' });
		expect(plan.preview.invoices.created.map((invoice) => [invoice.issue_date, invoice.subtotal])).toEqual([
			['2026-11-15', 300],
			// Último período corto (S4-16): 17 de los 31 días del ciclo 15-12 → 14-01.
			['2026-12-15', 164.52],
		]);
		expect(plan.preview.invoices.updated).toEqual([]);
	});

	it('mergeTarget: la línea de ciclo propio solo se funde con una PE de la misma fecha exacta; la del contrato no entra a una PE de ciclo propio', () => {
		const ownItem = itemRow({ id: 'own-1', product_id: PRODUCT_NUEVO, billing_anchor_day: 15, start_date: '2026-01-15' });
		const ownInvoice = invoiceRow('11', { id: 'inv-own', issue_date: '2026-11-15' });

		ownInvoice.lines = [
			{
				...ownInvoice.lines[0],
				id: 'line-own',
				contract_item_id: 'own-1',
				billing_period_start: '2026-11-15',
				billing_period_end: '2026-12-14',
			},
		];
		const ctx = context({ items: [itemRow(), soporteRow(), ownItem], invoices: [...context().invoices, ownInvoice] });
		const own = planChange(
			ctx,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 50, billing_cycle: 'own', account: 'B' }] },
				{ reason: 'ok' }
			)
		);

		expect(ops(own, 'create_invoices')[0].merge_into[0]).toBe('inv-own');
		const contractCycle = planChange(
			ctx,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 50, start_date: '2026-11-15', account: 'C' }] },
				{ reason: 'ok' }
			)
		);

		expect(ops(contractCycle, 'create_invoices')[0].merge_into).not.toContain('inv-own');
	});
});

// ------------------------------------------------------------------ cotización → contrato

describe('cotización → contrato: item_add / item_change con quote_item_id (S3-2 / S3-3 / S3-4)', () => {
	const QUOTE = 'q0000000-0000-4000-8000-000000000001';
	const quoteItem = (overrides: Partial<QuoteItemRow> = {}): QuoteItemRow => ({
		id: 'qi-1',
		quote_id: QUOTE,
		product_id: PRODUCT_NUEVO,
		product_name: 'Analítica',
		account: null,
		item_type: 'Recurrente',
		unit_of_measure: 'UND',
		quantity: 2,
		unit_price: 150,
		annual_unit_price: 1800,
		price_entry_mode: 'monthly',
		discount_value: 0,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		start_date: '2026-12-01',
		is_recurring: true,
		currency: 'CLP',
		price_spec: null,
		...overrides,
	});
	const quoteCtx = (items: QuoteItemRow[]) =>
		context({
			quote: { id: QUOTE, quote_type: 'Upsell', already_applied: false, currency: 'CLP' },
			quote_items: new Map(items.map((item) => [item.id, item])),
		});
	const origin = { origin: { type: 'quote' as const, quote_id: QUOTE }, reason: 'ok' };

	it('item_add: producto, cantidad, precio e inicio salen del ítem cotizado (S3-4) y el ítem queda con quote_item_id', () => {
		const plan = planChange(quoteCtx([quoteItem()]), request({ type: 'item_add', items: [{ quote_item_id: 'qi-1' }] }, origin));

		expect(inserted(plan)[0]).toMatchObject({
			product_id: PRODUCT_NUEVO,
			categoria: 'CROSS-SELL',
			quantity: 2,
			unit_price: 150,
			start_date: '2026-12-01',
			currency: 'CLP',
			quote_item_id: 'qi-1',
		});
		expect(plan.event.metadata.quote_items).toEqual(['qi-1']);
	});

	it('item_add: la moneda del ítem es la de la cotización (sin multimoneda → blocker con el paso siguiente)', () => {
		const plan = planChange(
			context({
				quote: { id: QUOTE, quote_type: 'Upsell', already_applied: false, currency: 'USD' },
				quote_items: new Map([['qi-1', quoteItem({ currency: 'USD' })]]),
			}),
			request({ type: 'item_add', items: [{ quote_item_id: 'qi-1' }] }, origin)
		);

		expect(inserted(plan)[0].currency).toBe('USD');
		expect(blockers(plan)).toContain('multicurrency_not_enabled');
	});

	it('item_change: upsell del ítem existente desde la cotización registra quote_item_id; ítem de otra cotización o sin origen → 400', () => {
		const plan = planChange(
			quoteCtx([quoteItem({ id: 'qi-2', product_id: PRODUCT_LICENCIA })]),
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100, quote_item_id: 'qi-2' }] }, origin)
		);

		expect(inserted(plan)[0]).toMatchObject({ categoria: 'UPSELL', quote_item_id: 'qi-2', related_item_id: LICENCIA });
		expect(
			fields(() =>
				planChange(
					quoteCtx([quoteItem({ id: 'qi-3', quote_id: 'otra' })]),
					request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100, quote_item_id: 'qi-3' }] }, origin)
				)
			)
		).toEqual(['change.items.0.quote_item_id']);
		expect(
			fields(() =>
				planChange(
					context(),
					request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 12, unit_price: 100, quote_item_id: 'qi-3' }] })
				)
			)
		).toEqual(['change.items.0.quote_item_id']);
	});
});

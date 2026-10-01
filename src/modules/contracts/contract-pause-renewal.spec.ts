// `contract-activation.service` → `InvoiceSchedulerService` importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

/**
 * Bloque Modificaciones B2-4 / B2-5 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §9.3.3 y §9.3.5): pausa y reanudación por ítem
 * (planes puros: Por Emitir sin el tramo con prorrateo por días en los bordes, decisión keep | void de las emitidas, `extend_term`, estado
 * Pausado), `billing_conditions.auto_renew` y confirmar una propuesta de renovación (`origin renewal_proposal`); reglas puras de los jobs.
 *
 * Fixture (`contract-changes.test-fixtures.ts`): contrato CLP, IVA 19, ciclo día 1, Licencia 10 × 100 y Soporte 1 × 200 de ene a dic 2026,
 * emitidas ene–sep (septiembre `Emitida`), Por Emitir oct–dic. Hoy = 28-09-2026.
 */
import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { type ChangeContext, type ChangePlan, type ItemPauseRow, planChange } from './contract-changes';
import { context, contractRow, itemRow, LICENCIA, request, SOPORTE, soporteRow } from './contract-changes.test-fixtures';
import {
	compactRenewalPreview,
	dueKey,
	dueScheduledChanges,
	groupRenewalCandidates,
	noticeLimit,
	proposalCounts,
	proposalKey,
	proposalView,
	type RenewalCandidate,
} from './contract-renewals';
import { deriveContractStatus, derivedStatusLateral } from './contract-status';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
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
const pauseRow = (overrides: Partial<ItemPauseRow> = {}): ItemPauseRow => ({
	id: 'pz-1',
	contract_item_id: LICENCIA,
	pause_start: '2026-11-01',
	pause_end: null,
	extend_term: false,
	status: 'scheduled',
	reason: null,
	...overrides,
});
/** Contexto con las Por Emitir de Licencia ya quitadas desde noviembre (lo que dejó una pausa abierta desde el 01-11). */
const pausedContext = (pause: Partial<ItemPauseRow> = {}, overrides: Partial<ChangeContext> = {}) => {
	const base = context();

	return context({
		pauses: [pauseRow(pause)],
		invoices: base.invoices.map((invoice) =>
			['inv-11', 'inv-12'].includes(invoice.id)
				? { ...invoice, subtotal: 200, lines: invoice.lines.filter((line) => line.contract_item_id !== LICENCIA) }
				: invoice
		),
		...overrides,
	});
};

// ------------------------------------------------------------------ pause (§9.3.3)

describe('pause (§9.3.3, S2-12)', () => {
	it('pausa abierta desde el 15-11: la PE de noviembre se prorratea por días (14/30, fin 14-11), diciembre pierde la línea; MRR 0 del ítem', () => {
		const plan = planChange(context(), request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-15' }));

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'insert_pause')).toEqual([
			{
				kind: 'insert_pause',
				pause: {
					contract_item_id: LICENCIA,
					pause_start: '2026-11-15',
					pause_end: null,
					extend_term: false,
					status: 'scheduled',
					reason: 'Pedido del cliente',
				},
			},
		]);
		const [november] = ops(plan, 'update_line');

		expect(november).toMatchObject({
			invoice_id: 'inv-11',
			line_id: 'line-11-lic',
			values: { subtotal: 466.67, billing_period_end: '2026-11-14', tax_amount: 88.67 },
		});
		expect(november.values.billing_period_start).toBeUndefined();
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-12-lic']);
		// Diciembre conserva Soporte: se recalcula, no se cancela.
		expect(plan.preview.invoices.cancelled).toEqual([]);
		expect(plan.preview.invoices.updated.map((invoice) => invoice.id).sort()).toEqual(['inv-11', 'inv-12']);
		expect(plan.preview.contract).toMatchObject({ before: { mrr: 1200 }, after: { mrr: 200 } });
		expect(plan.event).toMatchObject({
			type: 'PAUSE',
			subtype: 'open',
			amount_delta: -1000,
			items_affected: [LICENCIA],
			rsm_from_month: '2026-11-01',
		});
		expect(plan.preview.pauses).toEqual([
			expect.objectContaining({ item_id: LICENCIA, pause_start: '2026-11-15', pause_end: null, days_paused: null, status: 'scheduled' }),
		]);
	});

	it('pausa en el borde de inicio y fin: la línea queda desde el día siguiente al fin (billing_period_start); en medio solo baja el monto', () => {
		const edges = planChange(
			context(),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-10', pause_end: '2026-12-20' })
		);

		expect(
			ops(edges, 'update_line').map((op) => [op.line_id, op.values.subtotal, op.values.billing_period_start, op.values.billing_period_end])
		).toEqual([
			['line-11-lic', 300, undefined, '2026-11-09'],
			['line-12-lic', 354.84, '2026-12-21', undefined],
		]);
		const middle = planChange(
			context(),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-10', pause_end: '2026-11-20' })
		);
		const [line] = ops(middle, 'update_line');

		expect(line.values).toMatchObject({ subtotal: 633.33 });
		expect(line.values.billing_period_start).toBeUndefined();
		expect(line.values.billing_period_end).toBeUndefined();
		expect(line.values.description_suffix).toContain('2026-11-10 al 2026-11-20');
		expect(middle.event.subtype).toBe('fixed');
	});

	it('emitida que cubre la pausa → decisión keep | void (default void, blocker si falta); void emite la NC por los días pausados', () => {
		const base = { type: 'pause' as const, items: [{ item_id: LICENCIA }], pause_start: '2026-09-16', pause_end: '2026-10-15' };
		const missing = planChange(context(), request(base));

		expect(missing.preview.invoice_decisions_required).toEqual([
			expect.objectContaining({
				invoice_id: 'inv-09',
				status_group: 'issued',
				amount_after_effective: 500,
				options: ['keep', 'void'],
				default: 'void',
			}),
		]);
		expect(blockers(missing)).toEqual(['invoice_decision_required']);
		const voided = planChange(context(), request({ ...base, invoice_decisions: [{ invoice_id: 'inv-09', action: 'void' }] }));

		expect(voided.preview.can_apply).toBe(true);
		expect(ops(voided, 'credit_note')).toEqual([
			expect.objectContaining({
				mirrors: expect.objectContaining({ id: 'inv-09' }),
				lines: [expect.objectContaining({ ratio: 0.5, period_start: '2026-09-16' })],
			}),
		]);
		// Octubre (Por Emitir): 15 de 31 días pausados → queda desde el 16-10.
		expect(ops(voided, 'update_line')[0]).toMatchObject({
			line_id: 'line-10-lic',
			values: { subtotal: 516.13, billing_period_start: '2026-10-16' },
		});
		const kept = planChange(context(), request({ ...base, invoice_decisions: [{ invoice_id: 'inv-09', action: 'keep' }] }));

		expect(ops(kept, 'credit_note')).toEqual([]);
		expect(kept.event.metadata.invoice_decisions).toEqual([expect.objectContaining({ invoice_id: 'inv-09', action: 'keep', defaulted: false })]);
		expect(fields(() => planChange(context(), request({ ...base, invoice_decisions: [{ invoice_id: 'inv-10', action: 'void' }] })))).toEqual([
			'change.invoice_decisions.0.invoice_id',
		]);
	});

	it('bloqueos: item_already_paused (pausa abierta), pause_overlaps (se cruza con otra) y period_closed (inicio en período cerrado)', () => {
		const open = planChange(
			context({ pauses: [pauseRow({ pause_start: '2026-10-01' })] }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-15' })
		);

		expect(blockers(open)).toContain('item_already_paused');
		const overlap = planChange(
			context({ pauses: [pauseRow({ pause_start: '2026-10-01', pause_end: '2026-10-31' })] }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-10-15', pause_end: '2026-11-15' })
		);

		expect(blockers(overlap)).toContain('pause_overlaps');
		// Una pausa cancelada no cuenta.
		const cancelled = planChange(
			context({ pauses: [pauseRow({ pause_start: '2026-10-01', status: 'cancelled' })] }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-15' })
		);

		expect(blockers(cancelled)).toEqual([]);
		const closed = planChange(
			context({ contract: contractRow({ cutoff_date: '2026-10-31' }) }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-10-15' })
		);

		expect(blockers(closed)).toContain('period_closed');
		expect(
			fields(() =>
				planChange(context(), request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-15', pause_end: '2027-02-01' }))
			)
		).toEqual(['change.pause_end']);
	});

	it('extend_term con fin conocido: el fin de cada ítem se corre en los días pausados, el del contrato con bypass y el tramo nuevo se factura', () => {
		const plan = planChange(context(), request({ type: 'pause', pause_start: '2026-11-01', pause_end: '2026-11-30', extend_term: true }));

		expect(
			ops(plan, 'insert_pause')
				.map((op) => op.pause.contract_item_id)
				.sort()
		).toEqual([LICENCIA, SOPORTE].sort());
		expect(ops(plan, 'update_item').map((op) => [op.item_id, op.set.end_date])).toEqual([
			[LICENCIA, '2027-01-30'],
			[SOPORTE, '2027-01-30'],
		]);
		expect(ops(plan, 'update_contract')[0]).toMatchObject({ set: { contract_end_date: '2027-01-30' }, bypass_end_date_guard: true });
		// Noviembre queda sin líneas → Cancelada; enero 2027 nuevo con las dos líneas.
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['inv-11']);
		const january = plan.preview.invoices.created.find((invoice) => invoice.billing_period_start === '2027-01-01')!;

		expect(january.lines.map((line) => line.billing_period_end)).toEqual(['2027-01-30', '2027-01-30']);
		expect(plan.preview.pauses).toEqual([
			expect.objectContaining({ item_id: LICENCIA, days_paused: 30, end_date_before: '2026-12-31', end_date_after: '2027-01-30' }),
			expect.objectContaining({ item_id: SOPORTE, days_paused: 30, end_date_after: '2027-01-30' }),
		]);
		expect(plan.preview.contract.after.end_date).toBe('2027-01-30');
	});

	it('D3/MF-h: extend_term lleva los ajustes vivos al nuevo fin de su original (alineado: mismos días; desalineado: hasta el fin del original)', () => {
		const adjustment = (id: string, end: string) =>
			itemRow({
				id,
				categoria: 'UPSELL',
				related_item_id: LICENCIA,
				quantity: 2,
				monthly_price: 200,
				billing_period_price: 200,
				start_date: '2026-10-01',
				end_date: end,
				term_months: 3,
			});
		const plan = planChange(
			context({ items: [itemRow(), soporteRow(), adjustment('up-ok', '2026-12-31'), adjustment('up-short', '2026-11-30')] }),
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-01', pause_end: '2026-11-30', extend_term: true })
		);
		const ends = new Map<string, string>();

		for (const op of ops(plan, 'update_item')) if (op.set.end_date) ends.set(op.item_id, op.set.end_date);
		expect(Object.fromEntries(ends)).toEqual({ [LICENCIA]: '2027-01-30', 'up-ok': '2027-01-30', 'up-short': '2027-01-30' });
	});

	it('todos los recurrentes vivos pausados hoy → estado Pausado; reanudar se admite en Pausado y pausar no', () => {
		const ctx = context({ today: '2026-10-05' });
		const plan = planChange(ctx, request({ type: 'pause', pause_start: '2026-10-01' }));

		expect(plan.preview.contract.after).toMatchObject({ status: 'paused', mrr: 0 });
		const paused = context({
			today: '2026-10-05',
			pauses: [pauseRow({ pause_start: '2026-10-01' }), pauseRow({ id: 'pz-2', contract_item_id: SOPORTE, pause_start: '2026-10-01' })],
		});

		expect(blockers(planChange(paused, request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-01' })))).toContain(
			'not_active'
		);
		expect(blockers(planChange(paused, request({ type: 'resume', resume_date: '2026-11-01' })))).not.toContain('not_active');
	});
});

// ------------------------------------------------------------------ resume (§9.3.3)

describe('resume (§9.3.3)', () => {
	it('cierra la pausa (pause_end = reanudación − 1), rehace la PE de diciembre (se funde con la del mes) y con extend_term corre el fin', () => {
		const plan = planChange(pausedContext({ extend_term: true }), request({ type: 'resume', resume_date: '2026-12-01' }));

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'update_pause')).toEqual([{ kind: 'update_pause', id: 'pz-1', set: { pause_end: '2026-11-30', status: 'ended' } }]);
		expect(ops(plan, 'update_item')).toEqual([{ kind: 'update_item', item_id: LICENCIA, set: { end_date: '2027-01-30' } }]);
		const merged = plan.preview.invoices.updated.find((invoice) => invoice.id === 'inv-12')!;

		expect(merged).toMatchObject({ subtotal_before: 200, subtotal_after: 1200 });
		expect(plan.preview.invoices.created.map((invoice) => invoice.billing_period_start)).toEqual(['2027-01-01']);
		expect(plan.preview.contract).toMatchObject({ before: { mrr: 200 }, after: { mrr: 1200 } });
		expect(plan.event).toMatchObject({ type: 'RESUME', subtype: 'extend_term', amount_delta: 1000 });
		expect(plan.preview.pauses).toEqual([expect.objectContaining({ pause_id: 'pz-1', days_paused: 30, pause_end: '2026-11-30' })]);
	});

	it('sin extend_term no corre el fin; con fin conocido ya corrido al pausar, reanudar antes devuelve la diferencia', () => {
		const plain = planChange(pausedContext(), request({ type: 'resume', resume_date: '2026-12-01' }));

		expect(ops(plain, 'update_item')).toEqual([]);
		// Pausa 01-11 a 31-12 con extend_term: al pausar el fin pasó a 2027-03-02 (61 días); se reanuda el 01-12 (30 días) → 2027-01-30.
		const early = planChange(
			pausedContext({ pause_end: '2026-12-31', extend_term: true }, { items: [itemRow({ end_date: '2027-03-02' }), soporteRow()] }),
			request({ type: 'resume', items: [{ item_id: LICENCIA }], resume_date: '2026-12-01' })
		);

		expect(ops(early, 'update_item')).toEqual([{ kind: 'update_item', item_id: LICENCIA, set: { end_date: '2027-01-30' } }]);
	});

	it('pausa que aún no empezaba → cancelled; sin pausa que cerrar → not_paused', () => {
		const future = planChange(pausedContext({ pause_start: '2026-12-15' }), request({ type: 'resume', resume_date: '2026-12-01' }));

		expect(ops(future, 'update_pause')).toEqual([{ kind: 'update_pause', id: 'pz-1', set: { pause_end: null, status: 'cancelled' } }]);
		expect(future.preview.warnings.map((warning) => warning.code)).toContain('pause_cancelled');
		expect(blockers(planChange(context(), request({ type: 'resume', resume_date: '2026-12-01' })))).toEqual(['not_paused']);
		expect(blockers(planChange(context(), request({ type: 'resume', items: [{ item_id: SOPORTE }], resume_date: '2026-12-01' })))).toEqual([
			'not_paused',
		]);
	});
});

// ------------------------------------------------------------------ estado derivado Pausado (contract-status.ts)

describe('estado derivado Pausado (§9.3.3)', () => {
	const items = [
		{ id: 'a', is_recurring: true, categoria: 'NEW', churn_date: null, end_date: '2026-12-31', renewed_by_item_id: null },
		{ id: 'b', is_recurring: true, categoria: 'NEW', churn_date: null, end_date: '2026-12-31', renewed_by_item_id: null },
	];
	const pause = (id: string, start: string, end: string | null = null, status = 'active') => ({
		contract_item_id: id,
		pause_start: start,
		pause_end: end,
		status,
	});

	it('Pausado solo si todos los recurrentes vivos están pausados hoy (las canceladas y las terminadas no cuentan)', () => {
		expect(deriveContractStatus('Activo', items, '2026-10-05', [pause('a', '2026-10-01'), pause('b', '2026-09-01', '2026-10-31')])).toBe(
			'paused'
		);
		expect(deriveContractStatus('Activo', items, '2026-10-05', [pause('a', '2026-10-01')])).toBe('active');
		expect(deriveContractStatus('Activo', items, '2026-11-05', [pause('a', '2026-10-01'), pause('b', '2026-09-01', '2026-10-31')])).toBe(
			'active'
		);
		expect(deriveContractStatus('Activo', items, '2026-10-05', [pause('a', '2026-10-01'), pause('b', '2026-10-01', null, 'cancelled')])).toBe(
			'active'
		);
		expect(deriveContractStatus('Activo', items, '2026-10-05')).toBe('active');
	});

	it('el lateral SQL cuenta los recurrentes vivos pausados hoy (mismo criterio que el espejo TS)', () => {
		const sql = derivedStatusLateral('$2');

		expect(sql).toContain(`WHEN st.live_items > 0 AND st.paused_live = st.live_items THEN 'paused'`);
		expect(sql).toContain('FROM contract_item_pauses cip');
		expect(sql).toContain(`cip.status <> 'cancelled' AND cip.pause_start <= $2::date`);
	});
});

// ------------------------------------------------------------------ auto-renovación (§9.3.5)

describe('billing_conditions.auto_renew y confirmar una propuesta (§9.3.5)', () => {
	it('auto_renew enciende o apaga los recurrentes vivos que difieren (CONDITIONS_UPDATED); sin diferencias → 400', () => {
		const plan = planChange(
			context({ items: [itemRow({ auto_renew: true }), soporteRow({ auto_renew: false })] }),
			request({ type: 'billing_conditions', auto_renew: false })
		);

		expect(ops(plan, 'update_item')).toEqual([{ kind: 'update_item', item_id: LICENCIA, set: { auto_renew: false } }]);
		expect(plan.event).toMatchObject({ type: 'CONDITIONS_UPDATED' });
		expect(plan.event.metadata).toMatchObject({
			changed_fields: ['auto_renew'],
			fields_after: { auto_renew: false, auto_renew_items: [LICENCIA] },
		});
		expect(fields(() => planChange(context(), request({ type: 'billing_conditions', auto_renew: false })))).toEqual(['change']);
	});

	it('origin renewal_proposal: solo con renewal y event_id; la propuesta debe ser del contrato y estar abierta', () => {
		const change = { type: 'renewal' as const, items: [{ item_id: LICENCIA }] };
		const origin = { type: 'renewal_proposal' as const, event_id: 'e0000000-0000-4000-8000-0000000000ee' };

		expect(fields(() => planChange(context(), request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { origin })))).toEqual([
			'origin.type',
		]);
		expect(fields(() => planChange(context(), request(change, { origin: { type: 'renewal_proposal' } as never })))).toEqual(['origin.event_id']);
		expect(fields(() => planChange(context(), request(change, { origin })))).toEqual(['origin.event_id']);
		const dismissed = planChange(
			context({ renewal_proposal: { id: origin.event_id, status: 'dismissed', item_ids: [LICENCIA] } }),
			request(change, { origin })
		);

		expect(blockers(dismissed)).toEqual(['renewal_proposal_not_open']);
		const open = planChange(
			context({ renewal_proposal: { id: origin.event_id, status: 'open', item_ids: [LICENCIA] } }),
			request(change, { origin })
		);

		expect(open.preview.can_apply).toBe(true);
		expect(open.event.metadata.origin).toEqual(origin);
	});
});

// ------------------------------------------------------------------ reglas puras de los jobs (contract-renewals.ts)

describe('jobs: reglas puras (contract-renewals.ts)', () => {
	const candidate = (overrides: Partial<RenewalCandidate> = {}): RenewalCandidate => ({
		item_id: LICENCIA,
		contract_id: 'c-1',
		contract_number: 'CTR-1',
		product_name: 'Licencia',
		end_date: '2026-10-20',
		quantity: 10,
		unit_price: 100,
		monthly_price: 1000,
		currency: 'CLP',
		term_months: 12,
		billing_frequency: 'Mensual',
		...overrides,
	});

	it('propuestas: ventana de aviso (hoy + días, 1–180), agrupadas por contrato e idempotentes por ítem y fin', () => {
		expect(noticeLimit('2026-09-28', 30)).toBe('2026-10-28');
		expect(noticeLimit('2026-09-28', 999)).toBe('2027-03-27');
		const groups = groupRenewalCandidates(
			[
				candidate(),
				candidate({ item_id: SOPORTE, end_date: '2026-11-30' }),
				candidate({ item_id: 'x', contract_id: 'c-2', end_date: '2026-10-01' }),
				candidate({ item_id: 'y', contract_id: 'c-2', end_date: '2026-09-01' }),
			],
			new Set([proposalKey('y', '2026-09-01')]),
			'2026-09-28',
			30
		);

		expect([...groups.entries()].map(([id, items]) => [id, items.map((item) => item.item_id)])).toEqual([
			['c-1', [LICENCIA]],
			['c-2', ['x']],
		]);
		// Un fin nuevo (tras renovar) es otra clave: se vuelve a proponer.
		expect(
			groupRenewalCandidates([candidate({ end_date: '2026-10-21' })], new Set([proposalKey(LICENCIA, '2026-10-20')]), '2026-09-28', 30).size
		).toBe(1);
	});

	it('pactos por vencer: fecha ≤ hoy + aviso y sin aviso previo para esa fecha', () => {
		const pact = {
			id: 'p-1',
			contract_id: 'c-1',
			contract_number: null,
			contract_item_id: LICENCIA,
			product_name: 'Licencia',
			trigger: 'on_date' as const,
			kind: 'percent_uplift',
			value: 5,
			due_date: '2026-10-15',
			index_code: null,
		};

		expect(dueScheduledChanges([pact, { ...pact, id: 'p-2', due_date: '2026-12-01' }], new Set(), '2026-09-28', 30).map((row) => row.id)).toEqual(
			['p-1']
		);
		expect(dueScheduledChanges([pact], new Set([dueKey('p-1', '2026-10-15')]), '2026-09-28', 30)).toEqual([]);
	});

	it('vista de la propuesta: solo ítems aún pendientes, fin más próximo, días y conteos del KPI', () => {
		const row = {
			id: 'ev-1',
			contract_id: 'c-1',
			contract_number: 'CTR-1',
			client_name: 'Cliente',
			contract_currency: 'CLP',
			created_at: '2026-09-28T09:00:00Z',
			metadata: JSON.stringify({
				items: [
					{ item_id: 'a', end_date: '2026-10-20', monthly_price: 1000 },
					{ item_id: 'b', end_date: '2026-10-10', monthly_price: 200 },
				],
				preview: { available: true },
				pacts: [],
			}),
		};
		const view = proposalView(row, new Set(['a']), '2026-09-28')!;

		expect(view).toMatchObject({ event_id: 'ev-1', end_date: '2026-10-20', days_to_end: 22, renewal_start: '2026-10-21', monthly_total: 1000 });
		expect(view.items.map((item) => item.item_id)).toEqual(['a']);
		expect(proposalView(row, new Set(), '2026-09-28')).toBeNull();
		expect(proposalCounts([view, { ...view, days_to_end: 45 }, { ...view, days_to_end: -2 }])).toEqual({
			open: 3,
			renew_in_30_days: 1,
			overdue: 1,
		});
	});

	it('preview compacto de la propuesta (o el error si no se pudo calcular)', () => {
		expect(
			compactRenewalPreview({
				contract: { before: { mrr: 1200, end_date: '2026-12-31' }, after: { mrr: 1200, end_date: '2027-12-31' } },
				items: { added: [{}] },
				invoices: { created: [{}, {}], updated: [] },
				warnings: [{ code: 'retroactive_renewal' }],
				blockers: [],
				can_apply: true,
			})
		).toEqual({
			available: true,
			mrr_before: 1200,
			mrr_after: 1200,
			end_date_before: '2026-12-31',
			end_date_after: '2027-12-31',
			items_added: 1,
			invoices_created: 2,
			invoices_updated: 0,
			warnings: ['retroactive_renewal'],
			blockers: [],
			can_apply: true,
		});
		expect(compactRenewalPreview(null, 'boom')).toEqual({ available: false, error: 'boom' });
	});
});

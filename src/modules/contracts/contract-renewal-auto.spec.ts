/**
 * Renovación automática y cambios futuros que se aplican solos (Domi 13-11, SimpliRoute fin de año). Casos del acuerdo:
 * la renovación deja UN ítem con el valor vigente del grupo (madre + ampliaciones + reducciones) más el ajuste pactado, y un cambio
 * futuro "desde el mes" rige para cada ítem desde su primer período de ese mes, sin prorrateo.
 *
 * Fixture (`contract-changes.test-fixtures.ts`): contrato CLP, ciclo día 1, Licencia 10 × 100 y Soporte 1 × 200 de ene a dic 2026.
 */
import { type ChangePlan, planChange, type ScheduledChangeRow } from './contract-changes';
import { context, invoiceRow, itemRow, LICENCIA, SOPORTE, soporteRow } from './contract-changes.test-fixtures';
import { pactApplication } from './scheduled-changes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const inserted = (plan: ChangePlan) => ops(plan, 'insert_item').map((op) => (op as { item: Record<string, unknown> }).item);
const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));
const ITEM_KEYS = ['categoria', 'product_name', 'quantity', 'unit_price', 'monthly_price', 'start_date', 'end_date', 'auto_renew', 'related_item_id'];
const pact = (overrides: Partial<ScheduledChangeRow> = {}): ScheduledChangeRow => ({
	id: 'pact-1',
	contract_item_id: null,
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
const upsell = itemRow({
	id: 'up-1',
	categoria: 'UPSELL',
	related_item_id: LICENCIA,
	quantity: 3,
	unit_price: 100,
	monthly_price: 300,
	final_price: 2700,
	term_months: 9,
	start_date: '2026-04-01',
});
const downsell = itemRow({
	id: 'down-1',
	categoria: 'DOWNSELL',
	related_item_id: LICENCIA,
	quantity: 1,
	unit_price: -100,
	monthly_price: -100,
	final_price: -500,
	term_months: 5,
	start_date: '2026-08-01',
});

describe('renovación en un solo ítem con el valor vigente del grupo', () => {
	it('madre + ampliación + reducción → un RENEWAL neto (12 × 100); el +5 % pactado del contrato va como ajuste de cada ítem renovado', () => {
		const row = pact();
		const ctx = context({
			items: [itemRow({ auto_renew: true }), upsell, downsell, soporteRow({ auto_renew: true })],
			invoices: [],
			scheduled_changes: [row],
		});
		const application = pactApplication(ctx, row, {});
		const plan = planChange(ctx, application.request, application.options);

		expect(plan.preview.blockers).toEqual([]);
		expect(inserted(plan).map((item) => pick(item, ITEM_KEYS))).toEqual([
			expect.objectContaining({
				categoria: 'RENEWAL',
				product_name: 'Licencia',
				quantity: 12,
				unit_price: 100,
				start_date: '2027-01-01',
				auto_renew: true,
			}),
			expect.objectContaining({ categoria: 'UPSELL', product_name: 'Licencia', quantity: 12, unit_price: 5, related_item_id: 'new:1' }),
			expect.objectContaining({ categoria: 'RENEWAL', product_name: 'Soporte', quantity: 1, unit_price: 200, auto_renew: true }),
			expect.objectContaining({ categoria: 'UPSELL', product_name: 'Soporte', quantity: 1, unit_price: 10, related_item_id: 'new:3' }),
		]);
		// Los tres ítems del grupo quedan renovados: ninguno vuelve a alertar como vencido.
		expect(ops(plan, 'update_item').map((op) => [op.item_id, op.set.renewed_by_key])).toEqual([
			[LICENCIA, 'new:1'],
			['up-1', 'new:1'],
			['down-1', 'new:1'],
			[SOPORTE, 'new:3'],
		]);
		// El pacto de alcance contrato se marca aplicado una sola vez.
		expect(ops(plan, 'update_scheduled_change')).toEqual([
			{ kind: 'update_scheduled_change', id: 'pact-1', set: { status: 'applied', applied_value: 5 } },
		]);
	});
});

describe('cambio futuro "desde el mes": cada ítem desde su primer período de ese mes, sin prorrateo', () => {
	it('+5 % desde diciembre con Licencia (ciclo día 1) y Soporte (ciclo día 15)', () => {
		const row = pact({ trigger: 'on_date', effective_date: '2026-12-01', next_effective_date: '2026-12-01' });
		const soporte15 = soporteRow({ billing_anchor_day: 15, start_date: '2026-01-15', end_date: '2027-01-14' });
		const invoices = ['10', '11', '12'].map((mm) => {
			const base = invoiceRow(mm);

			return {
				...base,
				lines: base.lines.map((line) =>
					line.contract_item_id === SOPORTE
						? {
								...line,
								billing_period_start: `2026-${mm}-15`,
								billing_period_end: mm === '12' ? '2027-01-14' : `2026-${Number(mm) + 1}-14`,
							}
						: line
				),
			};
		});
		const ctx = context({ items: [itemRow(), soporte15], invoices, scheduled_changes: [row] });
		const application = pactApplication(ctx, row, {});

		expect(application.request.effective_date).toBe('2026-12-01');
		expect(application.options.item_effective_dates).toEqual({ [LICENCIA]: '2026-12-01', [SOPORTE]: '2026-12-15' });
		const plan = planChange(ctx, application.request, application.options);

		expect(plan.preview.blockers).toEqual([]);
		// Antes Soporte partía el 01-12 con el primer tramo prorrateado (14,67 por 1,5 meses): ahora parte en su período del 15-12, entero.
		expect(
			inserted(plan).map((item) => pick(item, ['product_name', 'categoria', 'unit_price', 'start_date', 'end_date', 'final_price']))
		).toEqual([
			{ product_name: 'Licencia', categoria: 'UPSELL', unit_price: 5, start_date: '2026-12-01', end_date: '2026-12-31', final_price: 50 },
			{ product_name: 'Soporte', categoria: 'UPSELL', unit_price: 10, start_date: '2026-12-15', end_date: '2027-01-14', final_price: 10 },
		]);
	});
});

describe('lo ya facturado no se ajusta', () => {
	it('con el mes pedido ya emitido, el cambio rige desde el día siguiente al último período emitido (sin cobrar diferencias)', () => {
		// Fixture: enero a septiembre emitidas. Un +5 % "desde septiembre" rige desde octubre.
		const row = pact({ trigger: 'on_date', effective_date: '2026-09-01', next_effective_date: '2026-09-01', contract_item_id: LICENCIA });
		const ctx = context({ scheduled_changes: [row] });
		const application = pactApplication(ctx, row, {});

		expect(application.options.item_effective_dates).toEqual({ [LICENCIA]: '2026-10-01' });
		const plan = planChange(ctx, application.request, application.options);

		expect(plan.preview.warnings.map((warning) => warning.code)).not.toContain('upsell_within_issued_period');
		expect(inserted(plan)[0]).toMatchObject({ categoria: 'UPSELL', start_date: '2026-10-01', unit_price: 5 });
	});
});

describe('cambio futuro agregado después de la renovación automática', () => {
	it('+5 % desde diciembre con el ítem ya renovado: aplica a diciembre del ítem vigente y a todo el ítem de la renovación', () => {
		const row = pact({ trigger: 'on_date', effective_date: '2026-12-01', next_effective_date: '2026-12-01' });
		const renovado = itemRow({ id: 'ren-1', categoria: 'RENEWAL', start_date: '2027-01-01', end_date: '2027-12-31', renews_item_id: LICENCIA });
		const ctx = context({
			items: [itemRow({ renewed_by_item_id: 'ren-1' }), renovado],
			invoices: ['10', '11', '12'].map((mm) => ({
				...invoiceRow(mm),
				lines: invoiceRow(mm).lines.filter((line) => line.contract_item_id === LICENCIA),
			})),
			scheduled_changes: [row],
			today: '2026-12-02',
		});
		const application = pactApplication(ctx, row, {});

		expect(application.options.item_effective_dates).toEqual({ [LICENCIA]: '2026-12-01', 'ren-1': '2027-01-01' });
		expect(application.options.renewed_item_ids).toEqual([LICENCIA]);
		const plan = planChange(ctx, application.request, application.options);

		expect(plan.preview.blockers).toEqual([]);
		expect(inserted(plan).map((item) => pick(item, ['categoria', 'unit_price', 'start_date', 'end_date', 'related_item_id']))).toEqual([
			{ categoria: 'UPSELL', unit_price: 5, start_date: '2026-12-01', end_date: '2026-12-31', related_item_id: LICENCIA },
			{ categoria: 'UPSELL', unit_price: 5, start_date: '2027-01-01', end_date: '2027-12-31', related_item_id: 'ren-1' },
		]);
	});

	it('un cambio manual de precio sobre un ítem ya renovado y vigente: rige hasta su fin y también en su renovación (con aviso)', () => {
		const renovado = itemRow({ id: 'ren-1', categoria: 'RENEWAL', start_date: '2027-01-01', end_date: '2027-12-31', renews_item_id: LICENCIA });
		const ctx = context({ items: [itemRow({ renewed_by_item_id: 'ren-1' }), renovado], invoices: [], today: '2026-12-02' });
		const plan = planChange(ctx, {
			effective_date: '2026-12-01',
			origin: { type: 'manual' },
			reason: 'Alza',
			change: { type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 105 }] },
		});

		expect(plan.preview.blockers).toEqual([]);
		expect(plan.preview.warnings.map((warning) => warning.code)).toContain('renewed_item_change');
		expect(inserted(plan).map((item) => pick(item, ['categoria', 'unit_price', 'start_date', 'end_date', 'related_item_id']))).toEqual([
			{ categoria: 'UPSELL', unit_price: 5, start_date: '2026-12-01', end_date: '2026-12-31', related_item_id: LICENCIA },
			{ categoria: 'UPSELL', unit_price: 5, start_date: '2027-01-01', end_date: '2027-12-31', related_item_id: 'ren-1' },
		]);
	});

	it('un ítem renovado que ya terminó sigue bloqueado: el cambio se hace sobre el ítem de la renovación', () => {
		const renovado = itemRow({ id: 'ren-1', categoria: 'RENEWAL', start_date: '2026-07-01', end_date: '2027-06-30', renews_item_id: LICENCIA });
		const ctx = context({ items: [itemRow({ renewed_by_item_id: 'ren-1', end_date: '2026-06-30' }), renovado], invoices: [] });
		const plan = planChange(ctx, {
			effective_date: '2026-12-01',
			origin: { type: 'manual' },
			reason: 'Alza',
			change: { type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 105 }] },
		});

		expect(plan.preview.blockers.map((blocker) => blocker.code)).toEqual(['item_already_renewed']);
	});
});

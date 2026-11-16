/**
 * Revertir un cambio programado ya aplicado (pedido de las usuarias 13-11): se deshace sin downsell, también si ya se facturó. El ítem
 * de ajuste se quita, su línea sale de las Por Emitir, la emitida que lo incluye se anula con su NC espejo (las dos Canceladas) y el
 * generador deja la Por Emitir del mismo período sin el ajuste.
 *
 * Fixture (`contract-changes.test-fixtures.ts`): contrato CLP, Licencia 10 × 100 y Soporte 1 × 200 de ene a dic 2026; enero a septiembre
 * emitidas, octubre a diciembre Por Emitir. El estado "ya aplicado" se arma con el plan real de aplicar el cambio (mismas líneas que
 * escribe el motor).
 */
import {
	type ChangeContext,
	type ChangeInvoiceRow,
	type ChangeItemRow,
	type ChangePlan,
	planChange,
	type ScheduledChangeRow,
} from './contract-changes';
import { context, invoiceRow, itemRow, LICENCIA, request, SOPORTE, soporteRow } from './contract-changes.test-fixtures';
import { pactApplication } from './scheduled-changes';

const ADJUSTMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PACT = 'pact-1';
const EVENT = 'event-applied';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const pact = (overrides: Partial<ScheduledChangeRow> = {}): ScheduledChangeRow => ({
	id: PACT,
	contract_item_id: LICENCIA,
	group_key: null,
	parent_id: null,
	trigger: 'on_date',
	effective_date: '2026-10-01',
	anchor_date: null,
	interval_months: null,
	next_effective_date: '2026-10-01',
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
const revertRequest = request({ type: 'scheduled_change_revert' } as never, { effective_date: '2026-10-10', reason: 'Se cargó por error' });
const options = { revert: { scheduled_change_id: PACT, event_id: EVENT, item_ids: [ADJUSTMENT] } };

/**
 * Contrato con el +5 % de Licencia ya aplicado desde octubre: el ítem de ajuste y sus líneas son los del plan real de aplicar el cambio.
 * `issuedOctober` deja la factura de octubre ya emitida (con la línea del ajuste dentro).
 */
function applied(issuedOctober: Partial<ChangeInvoiceRow> | null = { status: 'Emitida', invoice_number: 'F-10' }): ChangeContext {
	const row = pact();
	const before = context({ scheduled_changes: [row] });
	const application = pactApplication(before, row, {});
	const plan = planChange(before, application.request, application.options);
	const [inserted] = ops(plan, 'insert_item');
	const [created] = ops(plan, 'create_invoices');
	const adjustment: ChangeItemRow = itemRow({
		id: ADJUSTMENT,
		categoria: 'UPSELL',
		related_item_id: LICENCIA,
		quantity: inserted.item.quantity,
		unit_price: inserted.item.unit_price,
		monthly_price: inserted.item.quantity * inserted.item.unit_price,
		billing_period_price: inserted.item.quantity * inserted.item.unit_price,
		start_date: inserted.item.start_date,
		end_date: inserted.item.end_date,
		term_months: inserted.item.term_months,
		final_price: inserted.item.final_price,
		price: inserted.item.price,
	});
	const invoices = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((mm) => invoiceRow(mm));

	created.invoices.forEach((generated: { lines: Array<Record<string, unknown>>; subtotal: number }, index: number) => {
		const target = invoices.find((invoice) => invoice.id === created.merge_into[index])!;

		for (const line of generated.lines)
			target.lines.push({
				...target.lines[0],
				id: `line-adj-${target.id}`,
				contract_item_id: ADJUSTMENT,
				description: String(line.description),
				quantity: Number(line.quantity),
				unit_price: Number(line.unit_price),
				unit_price_invoice: Number(line.unit_price),
				subtotal: Number(line.subtotal),
				subtotal_invoice: Number(line.subtotal),
				tax_amount: Number(line.tax_amount),
				tax_amount_invoice: Number(line.tax_amount),
				total: Number(line.total),
				total_invoice: Number(line.total),
				billing_period_start: String(line.billing_period_start),
				billing_period_end: String(line.billing_period_end),
			});
		target.subtotal += generated.subtotal;
	});
	if (issuedOctober) Object.assign(invoices.find((invoice) => invoice.id === 'inv-10')!, issuedOctober);

	return context({
		items: [itemRow(), soporteRow(), adjustment],
		invoices,
		scheduled_changes: [pact({ status: 'applied' })],
		today: '2026-10-10',
	});
}

describe('el fixture refleja lo que escribe el motor al aplicar el cambio', () => {
	it('+5 % de Licencia desde octubre: ítem de ajuste 10 × 5 con una línea propia en octubre, noviembre y diciembre', () => {
		const ctx = applied(null);
		const lines = ctx.invoices.flatMap((invoice) => invoice.lines).filter((line) => line.contract_item_id === ADJUSTMENT);

		expect(ctx.items.find((item) => item.id === ADJUSTMENT)).toMatchObject({
			categoria: 'UPSELL',
			quantity: 10,
			unit_price: 5,
			start_date: '2026-10-01',
		});
		expect(lines.map((line) => [line.invoice_id, line.subtotal])).toEqual([
			['inv-10', 50],
			['inv-11', 50],
			['inv-12', 50],
		]);
	});
});

describe('revertir un cambio programado aplicado', () => {
	it('sin facturar todavía: quita la línea del ajuste de cada Por Emitir, borra el ítem y el MRR vuelve; sin NC', () => {
		const plan = planChange(applied(null), revertRequest, options);

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-adj-inv-10', 'line-adj-inv-11', 'line-adj-inv-12']);
		expect(ops(plan, 'credit_note')).toEqual([]);
		expect(ops(plan, 'create_invoices').flatMap((op) => op.invoices)).toEqual([]);
		expect(ops(plan, 'delete_reverted_item')).toEqual([{ kind: 'delete_reverted_item', item_id: ADJUSTMENT }]);
		expect(plan.preview.invoices.updated.map((invoice) => [invoice.id, invoice.subtotal_before, invoice.subtotal_after])).toEqual([
			['inv-10', 1250, 1200],
			['inv-11', 1250, 1200],
			['inv-12', 1250, 1200],
		]);
		expect(plan.preview.rsm?.mrr_delta).toBe(-50);
		expect(plan.event).toMatchObject({ type: 'SCHEDULED_CHANGE_REVERTED', amount_delta: -50, items_affected: [LICENCIA] });
		expect(plan.event.rsm_from_month).toBe('2026-10-01');
	});

	it('ya facturado: la emitida se anula con su NC espejo completa y se crea la Por Emitir del período sin el ajuste', () => {
		const plan = planChange(applied(), revertRequest, options);

		expect(plan.preview.blockers).toEqual([]);
		// NC espejo de TODAS las líneas, enteras → `insertMirrorCreditNote` deja la emitida y la NC Canceladas (regla del 12-10).
		const [creditNote] = ops(plan, 'credit_note');

		expect(creditNote.mirrors.id).toBe('inv-10');
		expect(creditNote.lines.map((entry: { line: { id: string }; ratio: number }) => [entry.line.id, entry.ratio])).toEqual([
			['line-10-lic', 1],
			['line-10-sop', 1],
			['line-adj-inv-10', 1],
		]);
		// La Por Emitir nueva de octubre: Licencia y Soporte, sin el ajuste; emisión hoy porque el período ya partió.
		const created = ops(plan, 'create_invoices').flatMap((op) => op.invoices);

		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			issue_date: '2026-10-10',
			billing_period_start: '2026-10-01',
			billing_period_end: '2026-10-31',
			subtotal: 1200,
		});
		expect(created[0].lines.map((line: { item_key: string; subtotal: number }) => [line.item_key, line.subtotal])).toEqual([
			[LICENCIA, 1000],
			[SOPORTE, 200],
		]);
		expect(ops(plan, 'create_invoices')[0].merge_into).toEqual([null]);
		// Noviembre y diciembre siguen Por Emitir: solo pierden la línea del ajuste.
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-adj-inv-11', 'line-adj-inv-12']);
		// El cambio queda cancelado con el motivo y el evento que lo aplicó queda marcado como revertido.
		expect(ops(plan, 'update_scheduled_change')).toEqual([
			{ kind: 'update_scheduled_change', id: PACT, set: { status: 'cancelled', status_reason: 'Revertido: Se cargó por error' } },
		]);
		expect(ops(plan, 'mark_events_reversed')).toEqual([{ kind: 'mark_events_reversed', event_ids: [EVENT] }]);
		expect(plan.preview.reverted_change).toMatchObject({
			scheduled_change_id: PACT,
			items: [{ item_id: ADJUSTMENT, product_name: 'Licencia', monthly_price: 50, start_date: '2026-10-01' }],
			invoices_voided: [{ id: 'inv-10', invoice_number: 'F-10' }],
		});
		expect(plan.preview.invoices.credit_notes).toHaveLength(1);
		expect(plan.event.description).toContain('1 factura emitida anulada');
	});

	it('bloquea si la emitida está pagada, tiene documento electrónico o el período está cerrado', () => {
		const codes = (ctx: ChangeContext) => planChange(ctx, revertRequest, options).preview.blockers.map((blocker) => blocker.code);
		const closed = applied();

		closed.contract = { ...closed.contract, cutoff_date: '2026-10-31' };
		expect(codes(applied({ status: 'Pagada', invoice_number: 'F-10' }))).toEqual(['invoice_paid']);
		expect(codes(applied({ status: 'Emitida', invoice_number: 'F-10', electronic: true }))).toEqual(['invoice_electronic']);
		expect(codes(closed)).toEqual(['period_closed']);
		// Bloqueado: no queda nada a medias en el plan.
		expect(ops(planChange(applied({ status: 'Pagada', invoice_number: 'F-10' }), revertRequest, options), 'update_scheduled_change')).toEqual([]);
	});

	it('solo se revierte un cambio aplicado, desde su fila, y que haya dejado un ajuste', () => {
		const codes = (ctx: ChangeContext, opts = options) => planChange(ctx, revertRequest, opts).preview.blockers.map((blocker) => blocker.code);
		const scheduled = applied();
		const term = applied();
		const renewed = applied();

		scheduled.scheduled_changes = [pact()];
		term.scheduled_changes = [pact({ status: 'applied', kind: 'term', value: 24 })];
		renewed.items = renewed.items.map((item) => (item.id === ADJUSTMENT ? { ...item, renewed_by_item_id: 'ren-1' } : item));
		expect(codes(scheduled)).toEqual(['scheduled_change_not_applied']);
		expect(codes(term)).toEqual(['revert_not_supported']);
		expect(codes(renewed)).toEqual(['adjustment_closed']);
		expect(codes(applied(), { revert: { ...options.revert, item_ids: [] } })).toEqual(['nothing_to_revert']);
		expect(planChange(applied(), revertRequest).preview.blockers.map((blocker) => blocker.code)).toEqual(['revert_from_scheduled_change']);
	});
});

describe('revertir una reducción aplicada (ajuste neto)', () => {
	// Cantidad 10 → 8 desde noviembre: el motor deja un DOWNSELL sin línea propia y la línea de Licencia de cada Por Emitir al valor neto.
	const reduced = (): ChangeContext => {
		const invoices = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((mm) => invoiceRow(mm));

		for (const invoice of invoices.filter((row) => row.id === 'inv-11' || row.id === 'inv-12')) {
			Object.assign(invoice.lines[0], { quantity: 8, subtotal: 800, subtotal_invoice: 800, tax_amount: 152, total: 952 });
			invoice.subtotal = 1000;
		}

		return context({
			items: [
				itemRow(),
				soporteRow(),
				itemRow({
					id: ADJUSTMENT,
					categoria: 'DOWNSELL',
					related_item_id: LICENCIA,
					quantity: 2,
					unit_price: -100,
					monthly_price: -200,
					start_date: '2026-11-01',
				}),
			],
			invoices,
			scheduled_changes: [pact({ status: 'applied', kind: 'quantity', value: 8, effective_date: '2026-11-01' })],
			today: '2026-10-10',
		});
	};

	it('rehace la línea del ítem al valor anterior en las Por Emitir y el MRR sube lo que había bajado', () => {
		const plan = planChange(reduced(), revertRequest, options);

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(['line-11-lic', 'line-12-lic']);
		const [created] = ops(plan, 'create_invoices');

		expect(created.merge_into).toEqual(['inv-11', 'inv-12']);
		expect(created.invoices.map((invoice: { lines: Array<{ item_key: string; quantity: number; subtotal: number }> }) => invoice.lines)).toEqual([
			[expect.objectContaining({ item_key: LICENCIA, quantity: 10, subtotal: 1000 })],
			[expect.objectContaining({ item_key: LICENCIA, quantity: 10, subtotal: 1000 })],
		]);
		expect(ops(plan, 'cancel_invoice')).toEqual([]);
		expect(plan.preview.rsm?.mrr_delta).toBe(200);
	});
});

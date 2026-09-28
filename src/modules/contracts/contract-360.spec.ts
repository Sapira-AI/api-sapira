import { DataSource } from 'typeorm';

import {
	type BlockerContext,
	buildConsumption,
	buildLifecycle,
	buildSchedule,
	computeBlockers,
	computeFinancial,
	countedInvoices,
	fixedFxRate,
	fxPairLabel,
	groupTrailingRows,
	invoiceCurrencyInUse,
	type LifecycleInput,
	paymentTermsLabel,
	periodLabel,
	pickNextInvoice,
	type ScheduleInvoice,
	type ScheduleRow,
	scheduleState,
	summarizeItems,
	typicalPaymentTermsLabel,
} from './contract-360';
import { Contract360Service } from './contract-360.service';
import { ContractsService } from './contracts.service';

const TODAY = '2026-09-25';

const invoice = (overrides: Partial<ScheduleInvoice> = {}): ScheduleInvoice => ({
	id: overrides.id ?? 'inv-1',
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	is_active: true,
	issue_date: '2026-10-01',
	due_date: '2026-10-31',
	contract_currency: 'CLF',
	invoice_currency: 'CLP',
	amount_contract_ccy: 100,
	amount_invoice_ccy: 3_900_000,
	fx_contract_to_invoice: 39_000,
	requires_references: false,
	period_start: null,
	period_end: null,
	lines_count: 1,
	lines_without_product: 0,
	has_non_recurring: false,
	references_count: 0,
	...overrides,
});

const context = (overrides: Partial<BlockerContext> = {}): BlockerContext => ({
	requires_references: false,
	fx_invoice_policy: 'spot',
	contract_currency: 'CLF',
	auto_send: false,
	has_erp_partner: true,
	has_entity: true,
	today: TODAY,
	...overrides,
});

describe('computeFinancial', () => {
	it('suma facturas emitidas, resta notas de crédito y calcula el porcentaje sobre el valor total', () => {
		const result = computeFinancial(
			[
				invoice({ id: 'a', status: 'Pagada', amount_contract_ccy: 100, invoice_number: 'F-1' }),
				invoice({ id: 'b', status: 'Pagada', document_type: 'NC', amount_contract_ccy: 30 }),
				invoice({ id: 'c', status: 'Vencida', document_type: 'Invoice', amount_contract_ccy: 50, invoice_number: 'F-2' }),
				invoice({ id: 'd', status: 'Emitida', due_date: '2026-09-01', amount_contract_ccy: 20, invoice_number: 'F-3' }),
				invoice({ id: 'e', status: 'Enviada', due_date: '2026-10-10', amount_contract_ccy: 40 }),
				invoice({ id: 'f', status: 'Por Emitir', amount_contract_ccy: 70 }),
				invoice({ id: 'g', status: 'Por Emitir', amount_contract_ccy: 70 }),
				// No cuentan: cancelada, inactiva y un documento que no es factura ni NC.
				invoice({ id: 'h', status: 'Cancelada', amount_contract_ccy: 999 }),
				invoice({ id: 'i', status: 'Pagada', is_active: false, amount_contract_ccy: 999 }),
				invoice({ id: 'j', status: 'Pagada', document_type: 'GUIA', amount_contract_ccy: 999 }),
			],
			360,
			TODAY
		);

		expect(result).toEqual({
			invoiced_to_date: 180, // 100 − 30 + 50 + 20 + 40
			invoiced_pct: 50,
			pending_to_invoice: 140,
			pending_periods: 2,
			collected: 70,
			paid_count: 1,
			overdue: 70,
			overdue_count: 2,
			overdue_invoice_numbers: ['F-2', 'F-3'],
			open_receivable: 40,
		});
		expect(result.collected + result.overdue + result.open_receivable).toBe(result.invoiced_to_date);
	});

	it('la NC resta aunque venga en positivo y el porcentaje puede pasar de 100 o ser 0 sin valor total', () => {
		const rows = [
			invoice({ status: 'Pagada', amount_contract_ccy: 150 }),
			invoice({ id: 'nc', status: 'Pagada', document_type: 'NC', amount_contract_ccy: -10 }),
		];

		expect(computeFinancial(rows, 100, TODAY).invoiced_to_date).toBe(140);
		expect(computeFinancial(rows, 100, TODAY).invoiced_pct).toBe(140);
		expect(computeFinancial(rows, 0, TODAY).invoiced_pct).toBe(0);
	});
});

describe('computeBlockers', () => {
	const codes = (inv: ScheduleInvoice, ctx: BlockerContext) => computeBlockers(inv, ctx).map((blocker) => blocker.code);

	it('sin problemas no hay bloqueos', () => {
		expect(codes(invoice(), context())).toEqual([]);
	});

	it('detecta referencias faltantes (del contrato o de la factura), tasa fija sin cargar, ERP, producto y mes pasado', () => {
		const blockers = computeBlockers(
			invoice({ fx_contract_to_invoice: null, lines_without_product: 2, issue_date: '2026-08-31' }),
			context({ requires_references: true, fx_invoice_policy: 'fixed', auto_send: true, has_erp_partner: false })
		);

		expect(blockers.map((blocker) => blocker.code)).toEqual([
			'needs_reference',
			'fixed_fx_without_rate',
			'no_erp_partner',
			'item_without_product',
			'past_issue_date',
		]);
		expect(blockers.find((blocker) => blocker.code === 'past_issue_date')!.message).toBe(
			'La fecha de emisión quedó en un mes pasado: actualízala para que se envíe'
		);
		expect(blockers.find((blocker) => blocker.code === 'item_without_product')!.message).toBe(
			'2 líneas no tienen un producto del catálogo asociado.'
		);
		for (const blocker of blockers) {
			expect(blocker.message).not.toMatch(/odoo|_id|fx_|partner/i);
		}
		expect(codes(invoice({ requires_references: true }), context())).toEqual(['needs_reference']);
	});

	it('no bloquea si ya tiene referencias, la moneda coincide, no se envía solo o la emisión es de este mes', () => {
		expect(
			codes(
				invoice({ references_count: 1, invoice_currency: 'CLF', fx_contract_to_invoice: null, issue_date: '2026-09-01' }),
				context({ requires_references: true, fx_invoice_policy: 'fixed', auto_send: false, has_erp_partner: false })
			)
		).toEqual([]);
	});

	it('sin razón social el mensaje lo dice', () => {
		const [blocker] = computeBlockers(invoice(), context({ auto_send: true, has_erp_partner: false, has_entity: false }));

		expect(blocker.message).toContain('no tiene razón social');
	});
});

describe('pickNextInvoice', () => {
	it('elige la Por Emitir activa más temprana aunque esté en el pasado', () => {
		const next = pickNextInvoice([
			invoice({ id: 'later', issue_date: '2026-11-01' }),
			invoice({ id: 'past', issue_date: '2026-08-01' }),
			invoice({ id: 'inactive', issue_date: '2026-01-01', is_active: false }),
			invoice({ id: 'issued', issue_date: '2026-01-01', status: 'Emitida' }),
		]);

		expect(next?.id).toBe('past');
		expect(pickNextInvoice([invoice({ status: 'Pagada' })])).toBeNull();
	});
});

describe('buildLifecycle', () => {
	const base: LifecycleInput = {
		derived_status: 'active',
		created_at: '2026-01-10',
		activation_date: '2026-02-01',
		next_item_end_date: '2027-01-31',
		overdue_renewal_date: '2026-08-31',
		closed_date: null,
	};
	const states = (input: Partial<LifecycleInput>) => buildLifecycle({ ...base, ...input }).stages.map((stage) => stage.state);
	const renewal = (input: Partial<LifecycleInput>) => buildLifecycle({ ...base, ...input }).stages[2];

	it.each([
		['draft', ['current', 'upcoming', 'upcoming', 'skipped']],
		['active', ['done', 'current', 'upcoming', 'skipped']],
		['paused', ['done', 'current', 'upcoming', 'skipped']],
		['other', ['done', 'current', 'upcoming', 'skipped']],
		['pending_renewal', ['done', 'done', 'current', 'skipped']],
		['expired', ['done', 'done', 'current', 'skipped']],
		['cancelled', ['done', 'done', 'skipped', 'current']],
	] as const)('%s', (status, expected) => {
		expect(states({ derived_status: status })).toEqual(expected);
	});

	it('la etapa de renovación cambia de etiqueta y fecha según el estado', () => {
		expect(renewal({ derived_status: 'active' })).toMatchObject({ label: 'Próxima renovación', date: '2027-01-31' });
		expect(renewal({ derived_status: 'pending_renewal' })).toMatchObject({ label: 'Por renovar', date: '2026-08-31' });
		expect(renewal({ derived_status: 'expired', overdue_renewal_date: null, next_item_end_date: null })).toMatchObject({
			label: 'Vencido',
			date: null,
		});
	});

	it('cancelado sin activación: la etapa activa se salta y el cierre lleva la fecha', () => {
		const { stages } = buildLifecycle({ ...base, derived_status: 'cancelled', activation_date: null, closed_date: '2026-05-01' });

		expect(stages.map((stage) => [stage.key, stage.state, stage.date])).toEqual([
			['draft', 'done', '2026-01-10'],
			['active', 'skipped', null],
			['renewal', 'skipped', null],
			['closed', 'current', '2026-05-01'],
		]);
	});
});

describe('scheduleState', () => {
	it.each([
		[{ status: 'Cancelada' }, 'cancelled'],
		[{ status: 'Pagada', is_active: false }, 'cancelled'],
		[{ status: 'Pagada', document_type: 'NC' }, 'credit_note'],
		[{ status: 'Por Emitir' }, 'scheduled'],
		[{ status: 'Pagada' }, 'paid'],
		[{ status: 'Vencida' }, 'overdue'],
		[{ status: 'Enviada', due_date: '2026-09-24' }, 'overdue'],
		[{ status: 'Emitida', due_date: '2026-09-25' }, 'issued'],
	] as const)('%j → %s', (overrides, expected) => {
		expect(scheduleState(invoice(overrides), TODAY)).toBe(expected);
	});
});

describe('buildSchedule y agrupación', () => {
	const monthly = (month: number, overrides: Partial<ScheduleInvoice> = {}) => {
		const mm = String(month).padStart(2, '0');
		const year = month > 12 ? 2027 : 2026;
		const m = String(((month - 1) % 12) + 1).padStart(2, '0');

		return invoice({
			id: `inv-${mm}`,
			invoice_number: null,
			issue_date: `${year}-${m}-01`,
			due_date: `${year}-${m}-28`,
			period_start: `${year}-${m}-01`,
			period_end: `${year}-${m}-28`,
			...overrides,
		});
	};
	const options = { includeCancelled: false, tcv: 1200, today: TODAY, blockerContext: context() };

	it('agrupa la cola futura igual (más de 3) y deja sueltas las 2 primeras futuras', () => {
		const invoices = [
			monthly(8, { status: 'Pagada', invoice_number: 'F-8' }),
			monthly(9, { status: 'Emitida', invoice_number: 'F-9' }),
			...[10, 11, 12, 13, 14, 15, 16].map((month) => monthly(month)),
		];
		const { rows, totals, collection } = buildSchedule(invoices, options);

		expect(rows.map((row) => row.key)).toEqual(['inv-08', 'inv-09', 'inv-10', 'inv-11', 'group:inv-12']);
		const group = rows[4];

		expect(group).toMatchObject({
			state: 'scheduled',
			invoice_id: null,
			period_label: 'Dic 2026 → Abr 2027',
			amount_contract_ccy: 100,
			grouped: { count: 5, invoice_ids: ['inv-12', 'inv-13', 'inv-14', 'inv-15', 'inv-16'], total_contract_ccy: 500 },
		});
		expect(rows[0].period_label).toBe('Agosto 2026');
		expect(totals).toEqual({
			periods: 9,
			issued: 2,
			scheduled: 7,
			cancelled: 0,
			contract_total: 1200,
			scheduled_total: 700,
			issued_total: 200,
		});
		expect(collection).toEqual({
			paid: { amount: 100, count: 1 },
			overdue: { amount: 0, count: 0, invoice_numbers: [] },
			to_invoice: { amount: 700, count: 7 },
		});
	});

	it('no agrupa si la cola igual tiene 3 o menos, si cambia el monto o si hay bloqueos o setup', () => {
		const keys = (invoices: ScheduleInvoice[], ctx = context()) =>
			buildSchedule(invoices, { ...options, blockerContext: ctx }).rows.map((row) => row.key);
		const five = [10, 11, 12, 13, 14].map((month) => monthly(month));

		// 5 futuras: 2 sueltas + 3 iguales → no alcanza.
		expect(keys(five)).toHaveLength(5);
		// Monto distinto en medio corta la cola: solo 16–19 (4) se agrupan.
		const changed = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((month) => monthly(month, { amount_contract_ccy: month < 16 ? 100 : 120 }));

		expect(keys(changed)).toEqual(['inv-10', 'inv-11', 'inv-12', 'inv-13', 'inv-14', 'inv-15', 'group:inv-16']);
		// Con un bloqueo (referencias exigidas) nada se agrupa.
		const seven = [10, 11, 12, 13, 14, 15, 16].map((month) => monthly(month));

		expect(keys(seven, context({ requires_references: true }))).toHaveLength(7);
		// Un setup al final corta la cola.
		expect(keys([...seven.slice(0, 6), monthly(16, { has_non_recurring: true })])).toHaveLength(7);
	});

	it('excluye canceladas salvo includeCancelled y muestra la NC en negativo', () => {
		const invoices = [
			monthly(8, { status: 'Pagada' }),
			monthly(8, { id: 'nc', status: 'Pagada', document_type: 'NC', amount_contract_ccy: 40, amount_invoice_ccy: 1_560_000 }),
			monthly(9, { id: 'x', status: 'Cancelada' }),
			monthly(9, { id: 'y', is_active: false }),
		];
		const hidden = buildSchedule(invoices, options);
		const shown = buildSchedule(invoices, { ...options, includeCancelled: true });

		expect(hidden.rows.map((row) => row.key)).toEqual(['inv-08', 'nc']);
		expect(hidden.totals.cancelled).toBe(2);
		expect(hidden.rows[1]).toMatchObject({ state: 'credit_note', amount_contract_ccy: -40, amount_invoice_ccy: -1_560_000 });
		expect(hidden.totals.issued_total).toBe(60);
		expect(shown.rows.filter((row) => row.state === 'cancelled').map((row) => row.key)).toEqual(['x', 'y']);
	});

	it('bloqueos solo en filas por emitir y período de respaldo por el mes de emisión', () => {
		const { rows } = buildSchedule(
			[
				invoice({ id: 'p', status: 'Pagada', lines_without_product: 1 }),
				invoice({ id: 's', lines_without_product: 1, issue_date: '2026-10-15' }),
			],
			options
		);

		expect(rows.find((row) => row.key === 'p')!.blockers).toEqual([]);
		expect(rows.find((row) => row.key === 's')!.blockers.map((blocker) => blocker.code)).toEqual(['item_without_product']);
		expect(rows.find((row) => row.key === 's')).toMatchObject({
			period_start: '2026-10-01',
			period_end: '2026-10-31',
			period_label: 'Octubre 2026',
		});
	});

	it('groupTrailingRows no toca una lista vacía', () => {
		expect(groupTrailingRows([] as ScheduleRow[], TODAY)).toEqual([]);
	});
});

describe('etiquetas', () => {
	it('período, par de monedas y condiciones de pago', () => {
		expect(periodLabel('2026-03-01', '2026-03-31')).toBe('Marzo 2026');
		expect(periodLabel('2026-03-01', '2027-02-28')).toBe('Mar 2026 → Feb 2027');
		expect(fxPairLabel('CLF', 'CLP')).toBe('UF → CLP');
		expect(fxPairLabel('USD', 'usd')).toBeNull();
		expect(paymentTermsLabel({ kind: 'net', days: 30 })).toBe('30 días');
		expect(paymentTermsLabel({ kind: 'net', days: 0 })).toBe('Contado');
		expect(paymentTermsLabel({ kind: 'end_of_month', days: 15 })).toBe('Fin de mes + 15 días');
		expect(paymentTermsLabel({ kind: 'day_of_next_month', day: 10 })).toBe('Día 10 del mes siguiente');
		expect(paymentTermsLabel(null)).toBeNull();
		expect(
			typicalPaymentTermsLabel([
				{ issue_date: '2026-01-01', due_date: '2026-01-31', document_type: 'FACTURA' },
				{ issue_date: '2026-02-01', due_date: '2026-03-03', document_type: 'FACTURA' },
				{ issue_date: '2026-03-01', due_date: '2026-03-31', document_type: 'FACTURA' },
			])
		).toBe('30 días');
	});

	it('tipo de cambio fijo: el más frecuente solo con política fija', () => {
		const rows = [
			invoice({ fx_contract_to_invoice: 39_000 }),
			invoice({ status: 'Pagada', fx_contract_to_invoice: 39_000 }),
			invoice({ status: 'Emitida', fx_contract_to_invoice: 38_000 }),
			invoice({ status: 'Cancelada', fx_contract_to_invoice: 1 }),
			invoice({ status: 'Cancelada', fx_contract_to_invoice: 1 }),
			invoice({ status: 'Cancelada', fx_contract_to_invoice: 1 }),
		];

		expect(fixedFxRate('fixed', rows)).toBe(39_000);
		expect(fixedFxRate('spot', rows)).toBeNull();
	});
});

describe('summarizeItems', () => {
	const item = (overrides: Record<string, unknown> = {}) => ({
		is_recurring: true,
		categoria: null,
		churn_date: null,
		start_date: '2026-01-01',
		end_date: '2026-12-31',
		renewed_by_item_id: null,
		auto_renew: false,
		auto_renew_term_months: null,
		term_months: 12,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		...overrides,
	});

	it('cuenta vigentes y con renovación automática, frecuencia y método más comunes, y el primer vencido', () => {
		const result = summarizeItems(
			[
				item({ auto_renew: true, auto_renew_term_months: 24 }),
				item({ billing_frequency: 'Anual' }),
				item({ billing_method: 'Vencido' }),
				item({ end_date: '2026-08-31' }), // terminó sin decisión
				item({ end_date: '2026-06-30', renewed_by_item_id: 'x' }), // renovado
				item({ categoria: 'CHURN' }),
				item({ is_recurring: false, billing_frequency: 'Anual' }),
			],
			TODAY,
			36
		);

		expect(result).toEqual({
			renewal: { auto_renew_items: 1, recurring_items: 3, term_months: 24 },
			frequency: 'Mensual',
			method: 'Anticipado',
			overdue_renewal_date: '2026-08-31',
		});
		expect(summarizeItems([], TODAY, 36).renewal.term_months).toBe(36);
	});
});

describe('buildConsumption', () => {
	it('cruza cantidades con su ítem y con la factura del mismo mes (gana la vigente); nada usa precio por uso hoy', () => {
		const result = buildConsumption(
			[
				{ id: 'q1', contract_item_id: 'it-1', period: '2026-06-15', quantity: 20, unit_price: 1.33, amount: null, account: null },
				{ id: 'q2', contract_item_id: 'it-1', period: '2026-07-01', quantity: 5, unit_price: 2, amount: 10, account: 'Cuenta B' },
			],
			[
				{ id: 'it-1', product_name: 'Licencias', account: 'Cuenta A' },
				{ id: 'it-2', product_name: 'Soporte', account: null },
			],
			[
				{
					contract_item_id: 'it-1',
					billing_period_start: '2026-06-01',
					invoice_id: 'old',
					invoice_number: 'F-1',
					status: 'Cancelada',
					is_active: true,
				},
				{
					contract_item_id: 'it-1',
					billing_period_start: '2026-06-01',
					invoice_id: 'new',
					invoice_number: 'F-2',
					status: 'Pagada',
					is_active: true,
				},
				{
					contract_item_id: 'it-2',
					billing_period_start: '2026-07-01',
					invoice_id: 'other',
					invoice_number: 'F-3',
					status: 'Pagada',
					is_active: true,
				},
			]
		);

		expect(result.uses_usage_pricing).toBe(false);
		expect(result.rows).toEqual([
			{
				id: 'q2',
				item_id: 'it-1',
				product_name: 'Licencias',
				account: 'Cuenta B',
				period: '2026-07-01',
				quantity: 5,
				unit_price: 2,
				amount: 10,
				invoice: null,
			},
			{
				id: 'q1',
				item_id: 'it-1',
				product_name: 'Licencias',
				account: 'Cuenta A',
				period: '2026-06-01',
				quantity: 20,
				unit_price: 1.33,
				amount: 26.6,
				invoice: { id: 'new', number: 'F-2', status: 'Pagada' },
			},
		]);
		expect(result.items).toEqual([
			{ item_id: 'it-1', product_name: 'Licencias', account: 'Cuenta A', uses_usage_pricing: false },
			{ item_id: 'it-2', product_name: 'Soporte', account: null, uses_usage_pricing: false },
		]);
	});
});

describe('Contract360Service', () => {
	const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
	const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));
		const contracts = {
			resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID }),
			history: jest.fn().mockResolvedValue({
				data: [
					{ type: 'UPSELL', title: 'Upsell', effective_date: '2026-06-01', created_at: '2026-06-02T10:00:00.000Z' },
					{ type: 'ACTIVATION', title: 'Firma', effective_date: null, created_at: '2026-02-03T10:00:00.000Z' },
				],
			}),
		} as unknown as ContractsService;

		return { service: new Contract360Service({ query } as unknown as DataSource, contracts), query, contracts };
	};
	const asOf = new Date('2026-09-25T12:00:00.000Z');

	it('overview acota cada consulta al contrato y al holding y arma la respuesta', async () => {
		const { service, query, contracts } = build((sql) => {
			if (sql.includes('FROM contracts c') && sql.includes('documents_count'))
				return [
					{
						id: CONTRACT_ID,
						status: 'Activo',
						derived_status: 'active',
						created_at: new Date('2026-01-10T12:00:00.000Z'),
						contract_currency: 'CLF',
						invoice_currency: 'CLP',
						system_currency: 'USD',
						fx_invoice_policy: 'fixed',
						total_value: '1200',
						total_value_system_currency: '50000',
						requires_references_for_billing: true,
						auto_send_to_odoo: null,
						client_entity_id: 'e-1',
						odoo_partner_id: null,
						payment_terms: { kind: 'net', days: 30 },
						start_date: '2026-02-01',
						next_item_end_date: '2027-01-31',
						quote_id: 'q-1',
						quote_number: 'COT-1',
						seller_id: null,
						documents_count: '2',
						mrr_contract: '100',
						mrr_system: '4000',
					},
				];
			if (sql.includes('FROM invoices i') && sql.includes('references_count'))
				return [
					{
						id: 'i-1',
						status: 'Pagada',
						document_type: 'FACTURA',
						is_active: true,
						contract_currency: 'CLF',
						invoice_currency: 'CLP',
						amount_contract_currency: '100',
						fx_contract_to_invoice: '39000',
					},
					{
						id: 'i-2',
						status: 'Por Emitir',
						document_type: 'FACTURA',
						is_active: true,
						issue_date: '2026-10-01',
						contract_currency: 'CLF',
						invoice_currency: 'CLP',
						amount_contract_currency: '100',
						amount_invoice_currency: null,
						fx_contract_to_invoice: null,
						references_count: '0',
					},
				];

			return [];
		});

		const result = await service.overview(CONTRACT_ID, 'h-1', asOf);

		expect(contracts.resolveContract).toHaveBeenCalledWith(CONTRACT_ID, 'h-1');
		for (const [sql, params] of query.mock.calls) {
			expect(params).toEqual(expect.arrayContaining([CONTRACT_ID, 'h-1']));
			expect(sql).toMatch(/holding_id = \$2/);
		}
		expect(query.mock.calls.find(([sql]) => (sql as string).includes('documents_count'))![0]).toContain(`(to_jsonb(c)->>'deleted_at') IS NULL`);
		expect(result.lifecycle.stages[1]).toMatchObject({ key: 'active', date: '2026-02-03', state: 'current' });
		expect(result.facts).toMatchObject({ fx_rate: 39000, billing: { payment_terms_label: '30 días' }, references: { required: true } });
		expect(result.financial).toMatchObject({ mrr: 100, tcv: 1200, invoiced_to_date: 100, invoiced_pct: 8.3, pending_to_invoice: 100 });
		expect(result.next_invoice?.blockers.map((blocker) => blocker.code)).toEqual(['needs_reference', 'fixed_fx_without_rate', 'no_erp_partner']);
		expect(result.links).toEqual({
			quote: { id: 'q-1', number: 'COT-1' },
			seller: null,
			documents_count: 2,
			last_change: { title: 'Upsell', date: '2026-06-01', type: 'UPSELL' },
		});
	});

	it('documents devuelve la lista sin URL y resuelve quién subió por auth_id', async () => {
		const { service, query } = build(() => [
			{ id: 'd-1', document_name: 'Contrato firmado.pdf', file_size: '2048', file_type: 'application/pdf', has_file: true, user_id: null },
		]);

		const result = await service.documents(CONTRACT_ID, 'h-1');

		expect(query.mock.calls[0][0]).toContain('pu.auth_id = d.uploaded_by');
		expect(query.mock.calls[0][1]).toEqual([CONTRACT_ID, 'h-1']);
		expect(result.data).toEqual([
			{
				id: 'd-1',
				name: 'Contrato firmado.pdf',
				size_bytes: 2048,
				mime_type: 'application/pdf',
				category: null,
				created_at: null,
				uploaded_by: null,
				has_file: true,
			},
		]);
		expect(JSON.stringify(result)).not.toContain('file_url');
	});
});

describe('notas de crédito y moneda en uso', () => {
	it('una NC que anula una factura ya cancelada no resta dos veces', () => {
		const rows = [
			invoice({ id: 'ok', status: 'Pagada', amount_contract_ccy: 100 }),
			invoice({ id: 'annulled', status: 'Cancelada', amount_contract_ccy: 50 }),
			invoice({ id: 'nc-annul', status: 'Pagada', document_type: 'NC', amount_contract_ccy: 50, related_invoice_id: 'annulled' }),
			invoice({ id: 'nc-partial', status: 'Pagada', document_type: 'NC', amount_contract_ccy: 10, related_invoice_id: 'ok' }),
		];

		expect(countedInvoices(rows).map((row) => row.id)).toEqual(['ok', 'nc-partial']);
		expect(computeFinancial(rows, 100, TODAY)).toMatchObject({ invoiced_to_date: 90, collected: 90 });
	});

	it('la moneda de facturación y la tasa fija salen de las facturas en otra moneda', () => {
		const rows = [
			invoice({ contract_currency: 'USD', invoice_currency: 'PEN', fx_contract_to_invoice: 3.4 }),
			invoice({ contract_currency: 'USD', invoice_currency: 'USD', fx_contract_to_invoice: 1 }),
			invoice({ contract_currency: 'USD', invoice_currency: 'USD', fx_contract_to_invoice: 1 }),
		];

		expect(invoiceCurrencyInUse('USD', 'USD', rows)).toBe('PEN');
		expect(invoiceCurrencyInUse('USD', 'CLP', rows)).toBe('CLP');
		expect(invoiceCurrencyInUse('USD', null, [])).toBeNull();
		expect(fixedFxRate('fixed', rows, 'USD')).toBe(3.4);
	});
});

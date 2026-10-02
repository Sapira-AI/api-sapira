import {
	agingBucketOf,
	balanceOf,
	buildAging,
	cleanEmails,
	countGroups,
	daysOverdue,
	type DerivedInput,
	documentKindOf,
	electronicStateOf,
	EMAIL_STATUSES,
	erpStateOf,
	groupByContract,
	normalizeEmailStatus,
	paidWithoutFullPayments,
	type PaymentInvoiceRow,
	paymentStateOf,
	planPayments,
	queueBlockers,
	reminderMatch,
	renderTemplate,
	resultsFromContractBulk,
	statusAfterPayments,
	toIssueGroupOf,
	unknownTemplateVariables,
} from './billing-states';

const TODAY = '2026-10-01';

const issued = (overrides: Partial<DerivedInput> = {}): DerivedInput => ({
	status: 'Emitida',
	document_type: 'FACTURA',
	is_active: true,
	invoice_number: '1001',
	issue_date: '2026-09-01',
	due_date: '2026-10-15',
	total: 1000,
	paid: 0,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	has_erp_integration: true,
	has_erp_partner: true,
	...overrides,
});

describe('estados derivados (spec §3)', () => {
	it('document_kind: NC y variantes, ND, factura y sin tipo', () => {
		expect(documentKindOf('NC')).toBe('credit_note');
		expect(documentKindOf('Nota de crédito')).toBe('credit_note');
		expect(documentKindOf('ND')).toBe('debit_note');
		expect(documentKindOf('FACTURA_EXPORTACION')).toBe('invoice');
		expect(documentKindOf(null)).toBe('invoice');
	});

	it('payment_state: paid > partial > overdue > unpaid; n/a para Por Emitir, Cancelada, NC y anuladas', () => {
		expect(paymentStateOf(issued({ paid: 1000 }), TODAY)).toBe('paid');
		expect(paymentStateOf(issued({ status: 'Pagada' }), TODAY)).toBe('paid');
		expect(paymentStateOf(issued({ paid: 400, due_date: '2026-09-01' }), TODAY)).toBe('partial');
		expect(paymentStateOf(issued({ due_date: '2026-09-30' }), TODAY)).toBe('overdue');
		expect(paymentStateOf(issued(), TODAY)).toBe('unpaid');
		expect(paymentStateOf(issued({ status: 'Por Emitir' }), TODAY)).toBe('not_applicable');
		expect(paymentStateOf(issued({ status: 'Cancelada' }), TODAY)).toBe('not_applicable');
		expect(paymentStateOf(issued({ document_type: 'NC' }), TODAY)).toBe('not_applicable');
		expect(paymentStateOf(issued({ voided: true }), TODAY)).toBe('not_applicable');
	});

	it('saldo y días vencidos (B-F4, B-F17: total − pagos confirmados)', () => {
		expect(balanceOf(issued({ paid: 400 }))).toBe(600);
		expect(balanceOf(issued({ status: 'Pagada', paid: 0 }))).toBe(0);
		expect(balanceOf(issued({ total: null }))).toBeNull();
		expect(daysOverdue(issued({ due_date: '2026-09-21', paid: 100 }), TODAY)).toBe(10);
		expect(daysOverdue(issued({ due_date: '2026-09-21', paid: 1000 }), TODAY)).toBe(0);
	});

	it('Pagada con pagos parciales: saldo 0 y paid (regla única), marcada como paid_without_full_payments', () => {
		const row = issued({ status: 'Pagada', paid: 400 });

		expect(balanceOf(row)).toBe(0);
		expect(paymentStateOf(row, TODAY)).toBe('paid');
		expect(paidWithoutFullPayments(row)).toBe(true);
		expect(paidWithoutFullPayments(issued({ status: 'Pagada', paid: 1000 }))).toBe(false);
		expect(paidWithoutFullPayments(issued({ status: 'Emitida', paid: 400 }))).toBe(false);
	});

	it('erp_state: draft/sent por vínculo; not_applicable sin integración, sin partner o NC; none si puede ir y no fue', () => {
		expect(erpStateOf(issued({ status: 'Por Emitir', odoo_invoice_id: 9 }))).toBe('draft');
		expect(erpStateOf(issued({ sent_to_odoo_at: '2026-09-01T10:00:00Z' }))).toBe('sent');
		expect(erpStateOf(issued({ has_erp_integration: false }))).toBe('not_applicable');
		expect(erpStateOf(issued({ has_erp_partner: false }))).toBe('not_applicable');
		expect(erpStateOf(issued({ document_type: 'NC' }))).toBe('not_applicable');
		expect(erpStateOf(issued())).toBe('none');
	});

	it('electronic_state: NC pendiente, emitida vía ERP o externa, PE automática atrasada, anulada y sin cobro', () => {
		expect(electronicStateOf(issued({ document_type: 'NC', invoice_number: null }), TODAY)).toBe('pending_emission');
		expect(electronicStateOf(issued({ document_type: 'NC', odoo_invoice_id: 5 }), TODAY)).toBe('issued_erp');
		expect(electronicStateOf(issued({ issued_externally: true, odoo_invoice_id: 5 }), TODAY)).toBe('issued_external');
		expect(electronicStateOf(issued({ odoo_invoice_id: 5 }), TODAY)).toBe('issued_erp');
		expect(electronicStateOf(issued({ status: 'Por Emitir', auto_invoice: true, issue_date: '2026-09-28' }), TODAY)).toBe('pending_emission');
		expect(electronicStateOf(issued({ status: 'Por Emitir', auto_invoice: false, issue_date: '2026-09-28' }), TODAY)).toBe('not_issued');
		expect(electronicStateOf(issued({ voided: true }), TODAY)).toBe('voided');
		expect(electronicStateOf(issued({ status: 'Cancelada', no_charge: true }), TODAY)).toBe('not_issued');
		expect(electronicStateOf(issued({ status: 'Cancelada' }), TODAY)).toBe('voided');
	});
});

describe('estado por pagos (§6.7, Q3, B-F3, B-F14)', () => {
	const base = { status: 'Emitida', total: 1000, paid: 0, due_date: '2026-10-15', odoo_invoice_id: null, sent_to_odoo_at: null };

	it('Σ ≥ total → Pagada; parcial conserva el emitido o pasa a Vencida si venció', () => {
		expect(statusAfterPayments({ ...base, paid: 1000 }, TODAY)).toBe('Pagada');
		expect(statusAfterPayments({ ...base, paid: 999.996 }, TODAY)).toBe('Pagada');
		expect(statusAfterPayments({ ...base, paid: 500 }, TODAY)).toBe('Emitida');
		expect(statusAfterPayments({ ...base, status: 'Enviada', paid: 500, due_date: '2026-09-01' }, TODAY)).toBe('Vencida');
	});

	it('anular un pago de una Pagada vuelve atrás: Emitida (sin ERP), Enviada (en el ERP) o Vencida', () => {
		expect(statusAfterPayments({ ...base, status: 'Pagada', paid: 0 }, TODAY)).toBe('Emitida');
		expect(statusAfterPayments({ ...base, status: 'Pagada', paid: 200, odoo_invoice_id: 7 }, TODAY)).toBe('Enviada');
		expect(statusAfterPayments({ ...base, status: 'Pagada', paid: 200, due_date: '2026-09-01' }, TODAY)).toBe('Vencida');
		expect(statusAfterPayments({ ...base, status: 'Vencida', paid: 0, due_date: '2026-12-01' }, TODAY)).toBe('Emitida');
	});

	it('nunca toca Por Emitir, Cancelada ni legacy', () => {
		for (const status of ['Por Emitir', 'Cancelada', 'Consolidada', 'Dividida']) {
			expect(statusAfterPayments({ ...base, status, paid: 5000 }, TODAY)).toBe(status);
		}
	});
});

describe('planPayments (todo o nada)', () => {
	const invoice = (overrides: Partial<PaymentInvoiceRow> = {}): PaymentInvoiceRow => ({
		id: 'a',
		invoice_number: '1001',
		status: 'Emitida',
		document_type: 'FACTURA',
		is_active: true,
		voided: false,
		client_id: 'c1',
		contract_id: 'k1',
		invoice_currency: 'CLP',
		total: 1000,
		paid: 0,
		due_date: '2026-10-15',
		odoo_invoice_id: null,
		sent_to_odoo_at: null,
		cutoff_date: null,
		...overrides,
	});
	const input = (allocations: Array<{ invoice_id: string; amount: number }>, currency = 'CLP', payment_date = '2026-10-01') => ({
		allocations,
		currency,
		payment_date,
	});

	it('parcial y total: estado y saldo después', () => {
		const plan = planPayments(
			[invoice(), invoice({ id: 'b', invoice_number: '1002' })],
			input([
				{ invoice_id: 'a', amount: 400 },
				{ invoice_id: 'b', amount: 1000 },
			]),
			TODAY
		);

		expect(plan.can_apply).toBe(true);
		expect(plan.allocations[0].after).toMatchObject({ status: 'Emitida', paid: 400, balance: 600, payment_state: 'partial' });
		expect(plan.allocations[1].after).toMatchObject({ status: 'Pagada', balance: 0, payment_state: 'paid' });
		expect(plan.total_amount).toBe(1400);
	});

	it('bloqueos: Por Emitir (not_issued), NC, cancelada/anulada, moneda distinta, sobrepago acumulado, período cerrado, otro cliente', () => {
		const codes = (
			rows: PaymentInvoiceRow[],
			allocations: Array<{ invoice_id: string; amount: number }>,
			currency = 'CLP',
			date = '2026-10-01'
		) =>
			planPayments(rows, input(allocations, currency, date), TODAY).allocations.flatMap((entry) =>
				entry.blockers.map((blocker) => blocker.code)
			);

		expect(codes([invoice({ status: 'Por Emitir' })], [{ invoice_id: 'a', amount: 1 }])).toEqual(['not_issued']);
		expect(codes([invoice({ document_type: 'NC' })], [{ invoice_id: 'a', amount: 1 }])).toEqual(['credit_note']);
		expect(codes([invoice({ voided: true })], [{ invoice_id: 'a', amount: 1 }])).toEqual(['cancelled']);
		expect(codes([invoice()], [{ invoice_id: 'a', amount: 1 }], 'USD')).toEqual(['payment_currency_mismatch']);
		expect(
			codes(
				[invoice({ paid: 900 })],
				[
					{ invoice_id: 'a', amount: 50 },
					{ invoice_id: 'a', amount: 60 },
				]
			)
		).toEqual(['overpayment']);
		expect(codes([invoice({ cutoff_date: '2026-09-30' })], [{ invoice_id: 'a', amount: 1 }], 'CLP', '2026-09-15')).toEqual(['period_closed']);
		// Factura sin contrato: solo lectura en v2 (spec §11.1); el front la saca de la selección y la API también la rechaza.
		expect(codes([invoice({ contract_id: null })], [{ invoice_id: 'a', amount: 1 }])).toEqual(['no_contract']);
		const mixed = planPayments(
			[invoice(), invoice({ id: 'b', client_id: 'c2' })],
			input([
				{ invoice_id: 'a', amount: 1 },
				{ invoice_id: 'b', amount: 1 },
			]),
			TODAY
		);

		expect(mixed.blockers.map((blocker) => blocker.code)).toEqual(['client_mismatch']);
		expect(mixed.can_apply).toBe(false);
		expect(mixed.warnings).toEqual([]);
	});

	it('varios clientes a mano (conciliación, allowMultipleClients): client_mismatch pasa a aviso multiple_clients y no bloquea', () => {
		const plan = planPayments(
			[invoice(), invoice({ id: 'b', client_id: 'c2' })],
			input([
				{ invoice_id: 'a', amount: 1 },
				{ invoice_id: 'b', amount: 1 },
			]),
			TODAY,
			{ allowMultipleClients: true }
		);

		expect(plan.blockers).toEqual([]);
		expect(plan.warnings.map((warning) => warning.code)).toEqual(['multiple_clients']);
		expect(plan.can_apply).toBe(true);
	});
});

describe('antigüedad AR (§4.5, B-F9)', () => {
	it.each([
		[null, 'no_due_date'],
		['2026-10-01', 'not_due'],
		['2026-09-30', 'd1_30'],
		['2026-09-01', 'd1_30'],
		['2026-08-31', 'd31_60'],
		['2026-08-02', 'd31_60'],
		['2026-08-01', 'd61_90'],
		['2026-07-03', 'd61_90'],
		['2026-07-02', 'd90_plus'],
	])('vence %s → %s', (due, bucket) => {
		expect(agingBucketOf(due, TODAY)).toBe(bucket);
	});

	it('por cliente y moneda, sin sumar monedas; ignora saldos 0', () => {
		const result = buildAging(
			[
				{ client_id: 'c1', client_name: 'Acme', currency: 'CLP', due_date: '2026-09-15', balance: 100 },
				{ client_id: 'c1', client_name: 'Acme', currency: 'CLP', due_date: null, balance: 50 },
				{ client_id: 'c1', client_name: 'Acme', currency: 'usd', due_date: '2026-06-01', balance: 10 },
				{ client_id: 'c2', client_name: 'Beta', currency: 'CLP', due_date: '2026-11-01', balance: 0 },
			],
			TODAY
		);

		expect(result.by_currency).toEqual([
			expect.objectContaining({
				currency: 'CLP',
				buckets: { not_due: 0, d1_30: 100, d31_60: 0, d61_90: 0, d90_plus: 0, no_due_date: 50 },
				bucket_counts: { not_due: 0, d1_30: 1, d31_60: 0, d61_90: 0, d90_plus: 0, no_due_date: 1 },
				total: 150,
				invoices: 2,
			}),
			expect.objectContaining({
				currency: 'USD',
				buckets: { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 10, no_due_date: 0 },
				bucket_counts: { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 1, no_due_date: 0 },
				total: 10,
				invoices: 1,
			}),
		]);
		expect(result.clients.map((client) => `${client.name}|${client.currency}|${client.total}`)).toEqual(['Acme|CLP|150', 'Acme|USD|10']);
	});
});

describe('antigüedad: detalle del reporte Cuentas por cobrar', () => {
	const AS_OF = '2026-10-01';

	it('una fila por factura, último pago, atraso máximo y ponderado por saldo, y saldo en sistema (sin convertir no suma)', () => {
		const result = buildAging(
			[
				{
					client_id: 'c1',
					client_name: 'Acme',
					currency: 'CLP',
					due_date: '2026-09-21',
					balance: 300,
					id: 'a',
					invoice_number: 'F-1',
					balance_system: 0.3,
					last_payment_date: '2026-09-01',
				},
				{
					client_id: 'c1',
					client_name: 'Acme',
					currency: 'CLP',
					due_date: '2026-08-02',
					balance: 100,
					id: 'b',
					invoice_number: 'F-2',
					balance_system: 0.1,
					last_payment_date: '2026-09-20',
				},
				{
					client_id: 'c1',
					client_name: 'Acme',
					currency: 'CLP',
					due_date: '2026-11-01',
					balance: 600,
					id: 'c',
					invoice_number: 'F-3',
					balance_system: null,
				},
			],
			AS_OF
		);
		const [client] = result.clients;

		expect(client).toMatchObject({ total: 1000, total_system: 0.4, unconverted: 1, last_payment_date: '2026-09-20', max_days_overdue: 60 });
		// (10 × 300 + 60 × 100) / 400 = 22,5 → 23
		expect(client.avg_days_overdue).toBe(23);
		expect(result.by_currency[0]).toMatchObject({ total_system: 0.4, unconverted: 1, max_days_overdue: 60 });
		expect(result.invoices.map((invoice) => `${invoice.invoice_number}:${invoice.days_overdue}:${invoice.bucket}`)).toEqual([
			'F-2:60:d31_60',
			'F-1:10:d1_30',
			'F-3:0:not_due',
		]);
		expect(result.system).toEqual({
			buckets: { not_due: 0, d1_30: 0.3, d31_60: 0.1, d61_90: 0, d90_plus: 0, no_due_date: 0 },
			total: 0.4,
			unconverted: 1,
		});
	});
});

describe('cola Por emitir (§4.2)', () => {
	const blocker = (code: string) => ({ code, message: code, next_step: null });

	it('sin ERP se quitan los bloqueos del envío; con ERP quedan; acción por código y sin duplicados', () => {
		const all = [blocker('no_erp_integration'), blocker('erp_send_disabled'), blocker('needs_reference'), blocker('needs_reference')];

		expect(queueBlockers(all, 'external').map((entry) => [entry.code, entry.action])).toEqual([['needs_reference', 'references']]);
		expect(queueBlockers(all, 'erp').map((entry) => entry.code)).toEqual(['no_erp_integration', 'erp_send_disabled', 'needs_reference']);
	});

	it('grupo: borrador en el ERP > bloqueada > rezagada > lista; conteo por código', () => {
		const row = { odoo_invoice_id: null, sent_to_odoo_at: null, issue_date: '2026-10-10', scheduled_at: null };

		expect(toIssueGroupOf({ ...row, odoo_invoice_id: 3 }, [blocker('already_sent')], TODAY)).toBe('erp_draft');
		expect(toIssueGroupOf(row, [blocker('needs_reference')], TODAY)).toBe('blocked');
		expect(toIssueGroupOf({ ...row, issue_date: '2026-09-30' }, [], TODAY)).toBe('late');
		expect(toIssueGroupOf({ ...row, issue_date: null, scheduled_at: '2026-10-01' }, [], TODAY)).toBe('ready');
		expect(
			countGroups([
				{ group: 'blocked', blocked_reasons: [blocker('needs_reference'), blocker('period_closed')], currency: 'CLP', amount: 1000 },
				{ group: 'blocked', blocked_reasons: [blocker('needs_reference')], currency: 'usd', amount: 10.5 },
				{ group: 'blocked', blocked_reasons: [blocker('needs_reference')], currency: 'CLP', amount: 500 },
				{ group: 'ready', blocked_reasons: [], currency: 'USD', amount: null },
				{ group: 'late', blocked_reasons: [] },
			])
		).toEqual({
			ready: 1,
			blocked: { count: 3, by_code: { needs_reference: 3, period_closed: 1 } },
			late: 1,
			erp_draft: 0,
			// Monto por grupo y moneda de factura (nunca sumado entre monedas); spot sin valorizar → `unvalued`, no 0.
			amount_invoice_currency_by_currency: {
				ready: [{ currency: 'USD', amount: 0, invoices: 1, unvalued: 1 }],
				blocked: [
					{ currency: 'CLP', amount: 1500, invoices: 2, unvalued: 0 },
					{ currency: 'USD', amount: 10.5, invoices: 1, unvalued: 0 },
				],
				late: [{ currency: '—', amount: 0, invoices: 1, unvalued: 1 }],
				erp_draft: [],
			},
		});
	});
});

describe('fan-out por contrato (§4.7)', () => {
	it('agrupa por contrato en el orden pedido, sin duplicados; huérfanas con not_found / no_contract', () => {
		const grouping = groupByContract(
			['i1', 'i2', 'i3', 'i1', 'i4', 'i5'],
			[
				{ id: 'i1', contract_id: 'k1', invoice_number: '1' },
				{ id: 'i2', contract_id: 'k2', invoice_number: '2' },
				{ id: 'i3', contract_id: 'k1', invoice_number: '3' },
				{ id: 'i4', contract_id: null, invoice_number: '4' },
			]
		);

		expect(grouping.groups).toEqual([
			{ contract_id: 'k1', invoice_ids: ['i1', 'i3'] },
			{ contract_id: 'k2', invoice_ids: ['i2'] },
		]);
		expect(grouping.orphans.map((orphan) => [orphan.invoice_id, orphan.blockers[0].code])).toEqual([
			['i4', 'no_contract'],
			['i5', 'not_found'],
		]);
	});

	it('resultado por factura desde updated/skipped del contrato, con avisos por factura', () => {
		const results = resultsFromContractBulk('k1', ['i1', 'i3'], new Map([['i1', '1']]), {
			updated: ['i1'],
			skipped: [{ id: 'i3', blockers: [{ code: 'period_closed', message: 'cerrado', next_step: null }] }],
			warnings: [{ code: 'past_issue_date', message: 'pasada', invoice_id: 'i1' }],
		});

		expect(results).toEqual([
			{
				invoice_id: 'i1',
				invoice_number: '1',
				contract_id: 'k1',
				ok: true,
				blockers: [],
				warnings: [{ code: 'past_issue_date', message: 'pasada' }],
			},
			{
				invoice_id: 'i3',
				invoice_number: null,
				contract_id: 'k1',
				ok: false,
				blockers: [{ code: 'period_closed', message: 'cerrado', next_step: null, action: 'reschedule' }],
				warnings: [],
			},
		]);
	});
});

describe('recordatorios y plantillas (§4.6, B-F18)', () => {
	it('días antes y después del vencimiento; el día del vencimiento no cuenta como "después"', () => {
		expect(reminderMatch('2026-10-04', TODAY, [7, 3, 1], [1, 7])).toEqual({ trigger: 'before', days: 3 });
		expect(reminderMatch('2026-09-24', TODAY, [7, 3, 1], [1, 7])).toEqual({ trigger: 'after', days: 7 });
		expect(reminderMatch('2026-10-01', TODAY, [7, 3, 1], [1, 7])).toBeNull();
		expect(reminderMatch('2026-10-05', TODAY, [7, 3, 1], [1, 7])).toBeNull();
		expect(reminderMatch(null, TODAY, [1], [1])).toBeNull();
	});

	it('escapa valores y texto en HTML; detecta variables desconocidas', () => {
		const html = renderTemplate(
			'Hola {{client_name}},\\n<b>{{amount_due}}</b>',
			{ client_name: '<script>x</script>', amount_due: 'CLP 1.000' },
			true
		);

		expect(html).toBe('Hola &lt;script&gt;x&lt;/script&gt;,<br>&lt;b&gt;CLP 1.000&lt;/b&gt;');
		expect(renderTemplate('Factura {{invoice_number}}', { invoice_number: 'A&B' }, false)).toBe('Factura A&B');
		expect(unknownTemplateVariables('{{invoice_number}} {{saldo}} {{ saldo }}')).toEqual(['saldo']);
	});

	it('estado de un correo normalizado a queued|sent|delivered|failed|bounced|skipped (desconocido → sent)', () => {
		expect(['queued', 'sent', 'delivered', 'failed', 'bounced', 'skipped'].map(normalizeEmailStatus)).toEqual([...EMAIL_STATUSES]);
		expect(['pending', 'Delivered', 'error', 'bounce', 'suppressed', null, 'otro'].map(normalizeEmailStatus)).toEqual([
			'queued',
			'delivered',
			'failed',
			'bounced',
			'skipped',
			'sent',
			'sent',
		]);
	});

	it('correos: limpia, separa por coma o punto y coma y quita duplicados', () => {
		expect(cleanEmails(['a@x.cl; B@x.cl', 'b@x.cl', 'malo', null])).toEqual(['a@x.cl', 'B@x.cl']);
	});
});

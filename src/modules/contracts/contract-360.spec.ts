import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
	ACTIVATION_DATE_MISSING,
	type BlockerContext,
	buildConsumption,
	buildLifecycle,
	buildSchedule,
	computeBlockers,
	computeFinancial,
	contractDocumentPath,
	countedInvoices,
	fixedFxRate,
	fxPairLabel,
	groupConsumptionLines,
	groupTrailingRows,
	invoiceCurrencyInUse,
	type LifecycleInput,
	normalizeFxRates,
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
import { ContractDocumentsStorageService } from './storage/contract-documents-storage.service';

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
				// Atrasada: debía emitirse el 1 de septiembre y además se reprogramó (nació para el 1 de agosto).
				invoice({ id: 'g', status: 'Por Emitir', amount_contract_ccy: 70, issue_date: '2026-09-01', original_issue_date: '2026-08-01' }),
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
			pending_on_time: 70,
			pending_on_time_count: 1,
			pending_overdue: 70,
			pending_overdue_count: 1,
			pending_overdue_since: '2026-09-01',
			pending_rescheduled: 1,
			collected: 70,
			paid_count: 1,
			overdue: 70,
			overdue_count: 2,
			overdue_invoice_numbers: ['F-2', 'F-3'],
			open_receivable: 40,
			receivable: 110,
			total_invoiceable: 320,
			variance_vs_value: -40,
		});
		expect(result.collected + result.overdue + result.open_receivable).toBe(result.invoiced_to_date);
		expect(result.receivable).toBe(result.open_receivable + result.overdue);
		expect(result.pending_on_time + result.pending_overdue).toBe(result.pending_to_invoice);
		expect(result.total_invoiceable).toBe(result.invoiced_to_date + result.pending_to_invoice);
	});

	it('ítems variables (CTR-2026-142): el total facturable supera el valor base y el por cobrar incluye lo vencido', () => {
		// Valor base UF 156,96 (MRR 19,62 × 8); 4 emitidas vencidas (155,53) y 4 Por Emitir (239,44).
		const rows = [
			invoice({ id: 'a', status: 'Vencida', amount_contract_ccy: 38.88, due_date: '2026-06-30', invoice_number: 'F-1' }),
			invoice({ id: 'b', status: 'Vencida', amount_contract_ccy: 38.88, due_date: '2026-07-31', invoice_number: 'F-2' }),
			invoice({ id: 'c', status: 'Emitida', amount_contract_ccy: 38.88, due_date: '2026-08-31', invoice_number: 'F-3' }),
			invoice({ id: 'd', status: 'Emitida', amount_contract_ccy: 38.89, due_date: '2026-09-15', invoice_number: 'F-4' }),
			invoice({ id: 'e', status: 'Por Emitir', amount_contract_ccy: 59.86, issue_date: '2026-10-01' }),
			invoice({ id: 'f', status: 'Por Emitir', amount_contract_ccy: 59.86, issue_date: '2026-11-01' }),
			invoice({ id: 'g', status: 'Por Emitir', amount_contract_ccy: 59.86, issue_date: '2026-12-01' }),
			invoice({ id: 'h', status: 'Por Emitir', amount_contract_ccy: 59.86, issue_date: '2027-01-01' }),
			invoice({ id: 'x', status: 'Cancelada', amount_contract_ccy: 500 }),
		];
		const result = computeFinancial(rows, 156.96, TODAY);

		expect(result).toMatchObject({
			invoiced_to_date: 155.53,
			pending_to_invoice: 239.44,
			total_invoiceable: 394.97,
			variance_vs_value: 238.01,
			collected: 0,
			open_receivable: 0,
			overdue: 155.53,
			overdue_count: 4,
			receivable: 155.53,
		});
		expect(result.receivable).toBe(result.invoiced_to_date - result.collected);
	});

	it('por facturar: atrasado = Por Emitir con emisión anterior a hoy (la más antigua manda); reprogramada solo si cambió la fecha', () => {
		const rows = [
			invoice({ id: 'a', status: 'Por Emitir', amount_contract_ccy: 10, issue_date: '2026-07-01', original_issue_date: '2026-07-01' }),
			invoice({ id: 'b', status: 'Por Emitir', amount_contract_ccy: 20, issue_date: '2026-08-01', original_issue_date: '2026-06-01' }),
			invoice({ id: 'c', status: 'Por Emitir', amount_contract_ccy: 30, issue_date: TODAY }),
			invoice({ id: 'd', status: 'Por Emitir', amount_contract_ccy: 40, issue_date: null }),
		];

		expect(computeFinancial(rows, 0, TODAY)).toMatchObject({
			pending_overdue: 30,
			pending_overdue_count: 2,
			pending_overdue_since: '2026-07-01',
			pending_on_time: 70,
			pending_on_time_count: 2,
			pending_rescheduled: 1,
		});
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

	it('producto sin mapeo al ERP: bloquea con los productos nombrados solo si el contrato envía al ERP', () => {
		const [blocker] = computeBlockers(invoice({ unmapped_products: ['Plan Pro'] }), context({ auto_send: true }));

		expect(blocker.code).toBe('product_without_erp_mapping');
		expect(blocker.message).toContain('«Plan Pro»');
		expect(codes(invoice({ unmapped_products: ['Plan Pro'] }), context({ auto_send: false }))).toEqual([]);
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
		service_start_date: '2026-02-01',
		next_item_end_date: '2027-01-31',
		overdue_renewal_date: '2026-08-31',
		closed_date: null,
	};
	const states = (input: Partial<LifecycleInput>) => buildLifecycle({ ...base, ...input }).stages.map((stage) => stage.state);
	const expiry = (input: Partial<LifecycleInput>) => buildLifecycle({ ...base, ...input }).stages[2];

	it('las etapas son Borrador → Activo → Vencimiento → Cerrado', () => {
		expect(buildLifecycle(base).stages.map((stage) => [stage.key, stage.label])).toEqual([
			['draft', 'Borrador'],
			['active', 'Activo'],
			['expiry', 'Vencimiento'],
			['closed', 'Cancelado'],
		]);
	});

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

	it('la etapa de vencimiento cambia de etiqueta y fecha según el estado: Por renovar o Vencido con su fecha', () => {
		expect(expiry({ derived_status: 'active' })).toMatchObject({ key: 'expiry', label: 'Vencimiento', date: '2027-01-31' });
		expect(expiry({ derived_status: 'pending_renewal' })).toMatchObject({ label: 'Por renovar', date: '2026-08-31', state: 'current' });
		expect(expiry({ derived_status: 'expired' })).toMatchObject({ label: 'Vencido', date: '2026-08-31', state: 'current' });
		expect(expiry({ derived_status: 'expired', overdue_renewal_date: null, next_item_end_date: null })).toMatchObject({
			label: 'Vencido',
			date: null,
		});
	});

	it('Activo lleva solo la fecha del evento de activación; sin evento queda sin fecha y con nota, nunca el inicio del servicio', () => {
		const withEvent = buildLifecycle({ ...base, service_start_date: '2025-10-01' }).stages[1];

		expect(withEvent).toMatchObject({ date: '2026-02-01', service_start_date: '2025-10-01' });
		expect(withEvent.note).toBeUndefined();

		const withoutEvent = buildLifecycle({ ...base, activation_date: null, service_start_date: '2025-10-01' }).stages;

		expect(withoutEvent[1]).toMatchObject({ state: 'current', date: null, note: ACTIVATION_DATE_MISSING, service_start_date: '2025-10-01' });
		// El borrador conserva su fecha aunque el servicio haya empezado antes (facturación retroactiva).
		expect(withoutEvent[0].date).toBe('2026-01-10');
		// Un borrador nunca lleva fecha de activación ni nota.
		expect(buildLifecycle({ ...base, derived_status: 'draft' }).stages[1]).toMatchObject({ date: null, state: 'upcoming' });
		expect(buildLifecycle({ ...base, derived_status: 'draft' }).stages[1].note).toBeUndefined();
	});

	it('las fechas son monotónicas: vencimiento o cierre anteriores a la etapa previa se omiten', () => {
		const dates = (input: Partial<LifecycleInput>) => buildLifecycle({ ...base, ...input }).stages.map((stage) => stage.date);

		expect(dates({ derived_status: 'expired', overdue_renewal_date: '2026-01-15' })).toEqual(['2026-01-10', '2026-02-01', null, null]);
		expect(dates({ derived_status: 'cancelled', closed_date: '2026-01-05' })).toEqual(['2026-01-10', '2026-02-01', null, null]);
		expect(dates({ derived_status: 'cancelled', closed_date: '2026-05-01' })).toEqual(['2026-01-10', '2026-02-01', null, '2026-05-01']);
		// Sin activación registrada, la referencia es la creación.
		expect(dates({ derived_status: 'cancelled', activation_date: null, closed_date: '2026-01-05' })).toEqual(['2026-01-10', null, null, null]);
	});

	it('cancelado sin activación: la etapa activa se salta y el cierre lleva la fecha', () => {
		const { stages } = buildLifecycle({ ...base, derived_status: 'cancelled', activation_date: null, closed_date: '2026-05-01' });

		expect(stages.map((stage) => [stage.key, stage.state, stage.date])).toEqual([
			['draft', 'done', '2026-01-10'],
			['active', 'skipped', null],
			['expiry', 'skipped', null],
			['closed', 'current', '2026-05-01'],
		]);
		expect(stages[1].note).toBeUndefined();
	});
});

describe('tasas guardadas y ruta de documentos', () => {
	it('normalizeFxRates filtra por propósito, invierte las filas viejas al revés y ordena por período', () => {
		const rows = [
			{ purpose: 'invoice', from_currency: 'CLF', to_currency: 'CLP', rate: 38_000, period_start: '2026-07-01', period_end: null },
			{ purpose: 'invoice', from_currency: 'CLF', to_currency: 'CLP', rate: 37_000, period_start: null, period_end: '2026-06-30' },
			{ purpose: 'company', from_currency: 'CLP', to_currency: 'CLF', rate: 0.000025, period_start: null, period_end: null },
			{ purpose: 'company', from_currency: 'CLF', to_currency: 'USD', rate: 0, period_start: null, period_end: null },
		];

		expect(normalizeFxRates(rows, 'invoice', 'CLF')).toEqual([
			{ rate: 37_000, period_start: null, period_end: '2026-06-30' },
			{ rate: 38_000, period_start: '2026-07-01', period_end: null },
		]);
		expect(normalizeFxRates(rows, 'company', 'clf')).toEqual([{ rate: 40_000, period_start: null, period_end: null }]);
		expect(normalizeFxRates([{ ...rows[0], purpose: null }], 'company', 'CLF')).toHaveLength(1);
	});

	it('contractDocumentPath saca la ruta del bucket desde la URL pública guardada', () => {
		expect(contractDocumentPath('https://x.supabase.co/storage/v1/object/public/contract-documents/abc/1758000000.pdf')).toBe(
			'abc/1758000000.pdf'
		);
		expect(contractDocumentPath('https://x.supabase.co/storage/v1/object/sign/contract-documents/abc/Contrato%20firmado.pdf?token=1')).toBe(
			'abc/Contrato firmado.pdf'
		);
		expect(contractDocumentPath('https://x.supabase.co/storage/v1/object/public/client-files/abc/1.pdf')).toBeNull();
		expect(contractDocumentPath('https://x.supabase.co/storage/v1/object/public/contract-documents/../x.pdf')).toBeNull();
		expect(contractDocumentPath('')).toBeNull();
		expect(contractDocumentPath(null)).toBeNull();
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
	const TODAY = '2026-11-10';
	const price = {
		id: 'pr-1',
		name: 'Tramos LatAm',
		version: 1,
		status: 'active',
		model: 'graduated' as const,
		quantity_type: 'metered' as const,
		billable_metric_id: 'm-1',
		tiers: [{ from: 1, to: null, per_unit_amount: 0.08, flat_amount: 0 }],
	};
	const items = [
		{
			id: 'it-1',
			product_name: 'Rutas',
			account: 'Cuenta A',
			quantity: 1000,
			unit_of_measure: 'ruta',
			price,
			metric: { id: 'm-1', code: 'rutas', name: 'Rutas completadas', unit: 'ruta', aggregation: 'sum' },
		},
		{ id: 'it-2', product_name: 'Soporte', account: null, quantity: 1, unit_of_measure: 'UND', price: null, metric: null },
	];
	const line = (overrides: Partial<Parameters<typeof buildConsumption>[0]['lines'][number]>) => ({
		line_id: 'l',
		contract_item_id: 'it-1',
		billing_period_start: '2026-10-01',
		billing_period_end: '2026-10-31',
		quantity: 1000,
		quantity_source: 'pending',
		subtotal: 80,
		pricing_breakdown: null,
		invoice_id: 'inv',
		invoice_number: null,
		status: 'Por Emitir',
		is_active: true,
		issue_date: '2026-11-01',
		document_type: 'FACTURA',
		invoice_type: 'Automatica',
		is_legacy: false,
		...overrides,
	});

	it('período consolidado (Domi 05-10): muestra la copia del unificado Por Emitir y acepta consumo (lo recalcula el origen)', () => {
		const result = buildConsumption({
			today: TODAY,
			entries: [],
			items: [items[0]],
			lines: [
				line({
					line_id: 'l-orig',
					contract_item_id: 'it-1',
					invoice_id: 'orig',
					is_active: false,
					consolidated_pending: true,
					quantity_source: 'pending',
				}),
				line({
					line_id: 'l-u',
					contract_item_id: 'it-1',
					invoice_id: 'u-1',
					invoice_number: null,
					invoice_type: 'Unificada',
					unified_v2: true,
					quantity_source: 'pending',
				}),
			],
		});

		expect(result.items[0].periods).toHaveLength(1);
		expect(result.items[0].periods[0]).toMatchObject({ accepts_consumption: true, invoice: { id: 'u-1', status: 'Por Emitir' } });
		// Unificado emitido: no acepta recálculo (complementaria o reemisión sobre él).
		const issued = buildConsumption({
			today: TODAY,
			entries: [],
			items: [items[0]],
			lines: [
				line({ line_id: 'l-orig', contract_item_id: 'it-1', invoice_id: 'orig', is_active: false, quantity_source: 'pending' }),
				line({ line_id: 'l-u', contract_item_id: 'it-1', invoice_id: 'u-1', invoice_type: 'Unificada', unified_v2: true, status: 'Emitida' }),
			],
		});

		expect(issued.items[0].periods[0]).toMatchObject({ accepts_consumption: false, invoice: { id: 'u-1', status: 'Emitida' } });
	});

	it('cruza consumos con la línea del período (gana la vigente), marca ítems medidos, períodos y pendientes; solo lee consumption_entries', () => {
		const result = buildConsumption({
			today: TODAY,
			entries: [
				{
					id: 'e1',
					contract_item_id: 'it-1',
					period_start: '2026-09-01',
					period_end: '2026-09-30',
					quantity: 1250,
					amount_override: null,
					apply_item_discount: true,
					account: null,
					is_estimated: false,
					source: 'manual',
					revision: 2,
					correction_reason: 'Reporte corregido',
					notes: null,
					idempotency_key: null,
					invoice_id: null,
					created_at: '2026-10-02T10:00:00.000Z',
					updated_at: '2026-10-03T10:00:00.000Z',
					revisions_count: 2,
					recorded_by: { id: 'u-1', name: 'Domi' },
					recorded_at: '2026-10-03T10:00:00.000Z',
					revisions: [
						{
							revision: 2,
							quantity: 1250,
							amount_override: null,
							correction_reason: 'Reporte corregido',
							recorded_by: { id: 'u-1', name: 'Domi' },
							recorded_at: '2026-10-03T10:00:00.000Z',
						},
						{
							revision: 1,
							quantity: 1200,
							amount_override: null,
							correction_reason: null,
							recorded_by: null,
							recorded_at: '2026-10-02T10:00:00.000Z',
						},
					],
				},
			],
			items,
			lines: [
				// Septiembre: la Por Emitir recalculada gana sobre la anulada del mismo período.
				line({
					line_id: 'l-old',
					invoice_id: 'old',
					invoice_number: 'F-1',
					status: 'Cancelada',
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
				}),
				line({
					line_id: 'l-sep',
					invoice_id: 'sep',
					invoice_number: 'F-2',
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					quantity: 1250,
					quantity_source: 'consumption',
					subtotal: 100,
					pricing_breakdown: [{ kind: 'tier', quantity: 1250, amount: 100, label: 'Tramo 1 (1+)' }],
				}),
				// Octubre terminó sin consumo: pendiente. Noviembre en curso: no es pendiente.
				line({ line_id: 'l-oct', invoice_id: 'oct', invoice_number: 'F-3' }),
				line({
					line_id: 'l-nov',
					invoice_id: 'nov',
					billing_period_start: '2026-11-01',
					billing_period_end: '2026-11-30',
					issue_date: '2026-12-01',
				}),
				line({
					line_id: 'l-sup',
					contract_item_id: 'it-2',
					invoice_id: 'sup',
					invoice_number: 'F-9',
					billing_period_start: '2026-07-01',
					billing_period_end: '2026-07-31',
					quantity: 1,
					quantity_source: 'fixed',
					subtotal: 10,
					status: 'Pagada',
				}),
			],
		});

		expect(result.uses_usage_pricing).toBe(true);
		expect(result.rows.map((row) => [row.kind, row.item_id, row.period, row.quantity, row.amount, row.invoice?.id ?? null])).toEqual([
			['entry', 'it-1', '2026-09-01', 1250, 100, 'sep'],
		]);
		// Una sola fuente (05-10): sin filas `legacy`; los overrides del front anterior llegan como entries (migración 1791600000000).
		expect(result.rows.some((row) => (row as { kind: string }).kind === 'legacy')).toBe(false);
		expect(result.rows[0]).toMatchObject({
			revision: 2,
			revisions_count: 2,
			source: 'manual',
			quantity_source: 'consumption',
			in_progress: false,
			unit: 'ruta',
		});
		expect(result.rows[0]).toMatchObject({ recorded_by: { id: 'u-1', name: 'Domi' }, recorded_at: '2026-10-03T10:00:00.000Z' });
		const entryRow = result.rows[0];

		if (entryRow.kind !== 'entry') throw new Error('se esperaba una fila entry');
		expect(entryRow.revisions.map((revision) => [revision.revision, revision.quantity, revision.recorded_by?.name ?? null])).toEqual([
			[2, 1250, 'Domi'],
			[1, 1200, null],
		]);
		expect(result.rows[0].pricing_breakdown).toEqual([{ kind: 'tier', quantity: 1250, amount: 100, label: 'Tramo 1 (1+)' }]);
		expect(result.items.map((item) => [item.item_id, item.uses_usage_pricing, item.metric?.code ?? null, item.periods.length])).toEqual([
			['it-1', true, 'rutas', 3],
			['it-2', false, null, 1],
		]);
		expect(
			result.items[0].periods.map((period) => [
				period.period_start,
				period.in_progress,
				period.upcoming,
				period.entry_id,
				period.accepts_consumption,
				period.invoice.id,
			])
		).toEqual([
			['2026-09-01', false, false, 'e1', true, 'sep'],
			['2026-10-01', false, false, null, true, 'oct'],
			['2026-11-01', true, false, null, true, 'nov'],
		]);
		expect(result.items[1].periods[0].accepts_consumption).toBe(false);
		expect(result.pending).toEqual([
			{
				item_id: 'it-1',
				product_name: 'Rutas',
				account: 'Cuenta A',
				period_start: '2026-10-01',
				period_end: '2026-10-31',
				invoice: {
					id: 'oct',
					number: 'F-3',
					status: 'Por Emitir',
					issue_date: '2026-11-01',
					document_type: 'FACTURA',
					is_complementary: false,
					complements_invoice_id: null,
					no_charge: false,
				},
			},
		]);
	});

	it('ítem de cantidad fija: se lista con uses_usage_pricing false pero no acepta consumo (Domi 05-10: se corrige con Editar factura); nunca entra en pendientes', () => {
		const result = buildConsumption({
			today: TODAY,
			entries: [],
			items: [items[1]],
			lines: [
				line({ line_id: 'l-std-oct', contract_item_id: 'it-2', invoice_id: 'std-oct', quantity: 1, quantity_source: 'fixed', subtotal: 100 }),
				line({
					line_id: 'l-std-sep',
					contract_item_id: 'it-2',
					invoice_id: 'std-sep',
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					status: 'Pagada',
					quantity: 1,
					quantity_source: 'fixed',
					subtotal: 100,
				}),
			],
		});

		expect(result.uses_usage_pricing).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ item_id: 'it-2', uses_usage_pricing: false, price: null, metric: null });
		expect(result.items[0].periods.map((period) => [period.period_start, period.accepts_consumption, period.quantity_source])).toEqual([
			['2026-09-01', false, 'fixed'],
			['2026-10-01', false, 'fixed'],
		]);
		expect(result.pending).toEqual([]);
	});

	it('sin ítems medidos: uses_usage_pricing false y sin pendientes', () => {
		const result = buildConsumption({ today: TODAY, entries: [], items: [items[1]], lines: [] });

		expect(result).toEqual({
			uses_usage_pricing: false,
			rows: [],
			items: [
				{
					item_id: 'it-2',
					product_name: 'Soporte',
					account: null,
					quantity: 1,
					unit_of_measure: 'UND',
					uses_usage_pricing: false,
					price: null,
					metric: null,
					periods: [],
				},
			],
			pending: [],
		});
	});
});

describe('Contract360Service', () => {
	const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
	const build = (impl: (sql: string, params: unknown[]) => unknown[], options: { history?: unknown[]; storageConfigured?: boolean } = {}) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));
		const contracts = {
			resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID }),
			history: jest.fn().mockResolvedValue({
				data: options.history ?? [
					{ type: 'UPSELL', title: 'Upsell', effective_date: '2026-06-01', created_at: '2026-06-02T10:00:00.000Z' },
					{ type: 'ACTIVATION', title: 'Firma', effective_date: null, created_at: '2026-02-03T10:00:00.000Z' },
				],
			}),
		} as unknown as ContractsService;
		const storage = {
			createDownloadUrl: jest.fn(async (path: string) => {
				if (options.storageConfigured === false) throw new ConflictException('La descarga de documentos no está disponible en este entorno');

				return { url: `https://storage.test/sign/${path}?token=x`, expires_at: '2026-09-25T12:01:00.000Z' };
			}),
		} as unknown as ContractDocumentsStorageService;

		return { service: new Contract360Service({ query } as unknown as DataSource, contracts, storage), query, contracts, storage };
	};
	const asOf = new Date('2026-09-25T12:00:00.000Z');
	const contextRow = (overrides: Record<string, unknown> = {}) => ({
		id: CONTRACT_ID,
		status: 'Activo',
		derived_status: 'active',
		created_at: new Date('2026-01-10T12:00:00.000Z'),
		contract_currency: 'CLF',
		invoice_currency: 'CLP',
		system_currency: 'USD',
		company_currency: 'CLP',
		fx_invoice_policy: 'fixed',
		fx_company_policy: 'fixed_period',
		fx_company_confirmed_at: new Date('2026-01-12T10:00:00.000Z'),
		total_value: '1200',
		total_value_system_currency: '50000',
		requires_references_for_billing: true,
		auto_send_to_odoo: null,
		client_entity_id: 'e-1',
		odoo_partner_id: null,
		payment_terms: { kind: 'net', days: 30 },
		billing_anchor_day: '5',
		document_type: 'FACTURA',
		start_date: '2026-02-01',
		end_date: '2027-01-31',
		next_item_end_date: '2027-01-31',
		quote_id: 'q-1',
		quote_number: 'COT-1',
		seller_id: null,
		documents_count: '2',
		mrr_contract: '100',
		mrr_system: '4000',
		...overrides,
	});
	const fxRows = [
		{ purpose: 'invoice', from_currency: 'CLF', to_currency: 'CLP', rate: '38000', period_start: null, period_end: '2026-06-30' },
		{ purpose: 'invoice', from_currency: 'CLF', to_currency: 'CLP', rate: '39000', period_start: '2026-07-01', period_end: null },
		{ purpose: 'company', from_currency: 'CLF', to_currency: 'CLP', rate: '37500', period_start: null, period_end: null },
	];

	it('overview acota cada consulta al contrato y al holding y arma la respuesta', async () => {
		const { service, query, contracts } = build((sql) => {
			if (sql.includes('FROM contracts c') && sql.includes('documents_count'))
				return [contextRow({ fx_company_policy: null, fx_company_confirmed_at: null })];
			if (sql.includes('AS recognized')) return [{ recognized: '250' }];
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
		for (const [sql, params] of query.mock.calls.filter(([sql]) => !String(sql).includes('to_jsonb(hs)'))) {
			// La zona horaria del holding (ronda 4) se lee aparte, solo por holding.
			expect(params).toEqual(expect.arrayContaining([CONTRACT_ID, 'h-1']));
			expect(sql).toMatch(/holding_id = \$2/);
		}
		const contextSql = query.mock.calls.find(([sql]) => (sql as string).includes('documents_count'))![0] as string;

		expect(contextSql).toContain('c.deleted_at IS NULL');
		expect(contextSql).toContain('c.payment_terms, c.billing_anchor_day, c.document_type');
		expect(contextSql).not.toContain('to_jsonb');
		// Inicio y fin del servicio: sin ítems dados de baja ni ajustes CHURN / DOWNSELL.
		expect(contextSql).toContain(`ci.churn_date IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')`);
		expect(result.lifecycle.stages[1]).toMatchObject({ key: 'active', date: '2026-02-03', state: 'current', service_start_date: '2026-02-01' });
		// Sin tasas guardadas: el fijo no se deduce de las facturas para la cabecera; lo aplicado va aparte.
		expect(result.facts).toMatchObject({
			fx_invoice_rates: [],
			fx_rate: null,
			fx_rate_applied: 39000,
			fx_company: { policy: null, rates: [], company_currency: 'CLP', confirmed_at: null },
			billing: {
				anchor_day: 5,
				document_type: 'FACTURA',
				payment_terms: { kind: 'net', days: 30 },
				payment_terms_label: '30 días',
				payment_terms_source: 'contract',
			},
			references: { required: true },
		});
		expect(result.financial).toMatchObject({
			mrr: 100,
			tcv: 1200,
			invoiced_to_date: 100,
			invoiced_pct: 8.3,
			pending_to_invoice: 100,
			pending_on_time: 100,
			pending_overdue: 0,
			pending_overdue_since: null,
			pending_rescheduled: 0,
			recognized_to_date: 250,
			invoiced_vs_recognized_pct: 40,
		});
		expect(result.facts).toMatchObject({ requires_multicompany_billing: false, requires_multicurrency_billing: false });
		expect(result.next_invoice).toMatchObject({
			days_overdue: null,
			original_issue_date: null,
			auto_send_to_erp: true,
			erp_partner_linked: false,
		});
		expect(result.next_invoice?.blockers.map((blocker) => blocker.code)).toEqual(['needs_reference', 'fixed_fx_without_rate', 'no_erp_partner']);
		const recognizedCall = query.mock.calls.find(([sql]) => (sql as string).includes('AS recognized'))!;

		expect(recognizedCall[1]).toEqual([CONTRACT_ID, 'h-1', '2026-09-25']);
		expect(result.links).toEqual({
			quote: { id: 'q-1', number: 'COT-1' },
			seller: null,
			documents_count: 2,
			last_change: { title: 'Upsell', date: '2026-06-01', type: 'UPSELL' },
		});
	});

	it('overview: las tasas fijas salen de contract_fx_period_rates por propósito; un borrador no deduce nada de facturas', async () => {
		const invoices = [
			{
				id: 'i-1',
				status: 'Por Emitir',
				document_type: 'FACTURA',
				is_active: true,
				contract_currency: 'CLF',
				invoice_currency: 'CLP',
				fx_contract_to_invoice: '39000',
			},
		];
		const { service, query } = build(
			(sql) => {
				if (sql.includes('FROM contracts c') && sql.includes('documents_count'))
					return [contextRow({ status: 'En revisión', derived_status: 'draft', payment_terms: null })];
				if (sql.includes('FROM contract_fx_period_rates r')) return fxRows;
				if (sql.includes('FROM invoices i') && sql.includes('references_count')) return invoices;

				return [];
			},
			{ history: [] }
		);

		const result = await service.overview(CONTRACT_ID, 'h-1', asOf);
		const ratesCall = query.mock.calls.find(([sql]) => (sql as string).includes('FROM contract_fx_period_rates r'))!;

		expect(ratesCall[1]).toEqual([CONTRACT_ID, 'h-1']);
		expect(result.facts.fx_invoice_rates).toEqual([
			{ rate: 38000, period_start: null, period_end: '2026-06-30' },
			{ rate: 39000, period_start: '2026-07-01', period_end: null },
		]);
		expect(result.facts).toMatchObject({ fx_rate: null, fx_rate_applied: null });
		expect(result.facts.fx_company).toEqual({
			policy: 'fixed_period',
			rates: [{ rate: 37500, period_start: null, period_end: null }],
			company_currency: 'CLP',
			confirmed_at: '2026-01-12T10:00:00.000Z',
		});
		// Sin condición propia ni facturas emitidas con vencimiento: nada que mostrar, y la fuente lo dice.
		expect(result.facts.billing).toMatchObject({ payment_terms: null, payment_terms_label: null, payment_terms_source: null });
		expect(result.lifecycle.stages.map((stage) => [stage.key, stage.state, stage.date])).toEqual([
			['draft', 'current', '2026-01-10'],
			['active', 'upcoming', null],
			['expiry', 'upcoming', '2027-01-31'],
			['closed', 'skipped', null],
		]);
	});

	it('overview: contrato activo sin evento de activación → Activo sin fecha y con nota; condición de pago deducida de facturas se marca', async () => {
		const invoices = [
			{
				id: 'i-1',
				status: 'Pagada',
				document_type: 'FACTURA',
				is_active: true,
				issue_date: '2026-03-01',
				due_date: '2026-03-31',
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
				issue_date: '2026-09-15',
				original_issue_date: '2026-09-01',
				contract_currency: 'CLF',
				invoice_currency: 'CLP',
				amount_contract_currency: '100',
				fx_contract_to_invoice: '39000',
			},
		];
		const { service } = build(
			(sql) => {
				if (sql.includes('FROM contracts c') && sql.includes('documents_count'))
					return [contextRow({ payment_terms: null, start_date: '2025-10-01' })];
				if (sql.includes('FROM invoices i') && sql.includes('references_count')) return invoices;

				return [];
			},
			{ history: [{ type: 'UPSELL', title: 'Upsell', effective_date: '2026-06-01', created_at: '2026-06-02T10:00:00.000Z' }] }
		);

		const result = await service.overview(CONTRACT_ID, 'h-1', asOf);

		expect(result.lifecycle.stages[0]).toMatchObject({ key: 'draft', date: '2026-01-10', state: 'done' });
		expect(result.lifecycle.stages[1]).toMatchObject({
			key: 'active',
			date: null,
			state: 'current',
			note: ACTIVATION_DATE_MISSING,
			service_start_date: '2025-10-01',
		});
		expect(result.facts.billing).toMatchObject({ payment_terms_label: '30 días', payment_terms_source: 'invoices' });
		expect(result.facts.fx_rate_applied).toBe(39000);
		// La próxima factura debía emitirse hace 10 días y se movió desde el 1 de septiembre.
		expect(result.next_invoice).toMatchObject({ id: 'i-2', days_overdue: 10, original_issue_date: '2026-09-01' });
		expect(result.financial).toMatchObject({
			pending_overdue: 100,
			pending_overdue_count: 1,
			pending_overdue_since: '2026-09-15',
			pending_rescheduled: 1,
			recognized_to_date: 0,
			invoiced_vs_recognized_pct: null,
		});
	});

	it('schedule: el tipo de cambio es solo el de facturación, con sus tasas y sin "confirmado por"', async () => {
		const { service } = build((sql) => {
			if (sql.includes('FROM contracts c') && sql.includes('documents_count')) return [contextRow()];
			if (sql.includes('FROM contract_fx_period_rates r')) return fxRows.slice(1);

			return [];
		});

		const result = await service.schedule(CONTRACT_ID, 'h-1', {}, asOf);

		expect(result.fx).toEqual({
			policy: 'fixed',
			rate: 39000,
			rates: [{ rate: 39000, period_start: '2026-07-01', period_end: null }],
			rate_applied: null,
			pair: 'UF → CLP',
			confirmed_at: null,
		});
		expect(JSON.stringify(result.fx)).not.toContain('confirmed_by');
	});

	describe('documentDownloadUrl', () => {
		const DOC_ID = '22222222-2222-4222-8222-222222222222';
		const fileUrl = 'https://x.supabase.co/storage/v1/object/public/contract-documents/11111111-1111-4111-8111-111111111111/1758000000.pdf';

		it('firma la ruta del bucket y acota el documento al contrato y al holding', async () => {
			const { service, query, storage } = build((sql) => (sql.includes('FROM contract_documents d') ? [{ file_url: fileUrl }] : []));

			await expect(service.documentDownloadUrl(CONTRACT_ID, DOC_ID, 'h-1')).resolves.toEqual({
				url: `https://storage.test/sign/${CONTRACT_ID}/1758000000.pdf?token=x`,
				expires_at: '2026-09-25T12:01:00.000Z',
			});
			const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('FROM contract_documents d'))!;

			expect(sql).toContain('d.id = $1 AND d.contract_id = $2 AND d.holding_id = $3');
			expect(params).toEqual([DOC_ID, CONTRACT_ID, 'h-1']);
			expect(storage.createDownloadUrl).toHaveBeenCalledWith(`${CONTRACT_ID}/1758000000.pdf`);
		});

		it('404 si el documento no es del contrato o no tiene archivo; 409 si el almacenamiento no está configurado', async () => {
			await expect(build(() => []).service.documentDownloadUrl(CONTRACT_ID, DOC_ID, 'h-1')).rejects.toBeInstanceOf(NotFoundException);
			await expect(build(() => [{ file_url: '' }]).service.documentDownloadUrl(CONTRACT_ID, DOC_ID, 'h-1')).rejects.toBeInstanceOf(
				NotFoundException
			);
			await expect(
				build(() => [{ file_url: fileUrl }], { storageConfigured: false }).service.documentDownloadUrl(CONTRACT_ID, DOC_ID, 'h-1')
			).rejects.toBeInstanceOf(ConflictException);
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

describe('groupConsumptionLines (per_tier, §3.8) y complementarias (§4.4)', () => {
	const base = {
		contract_item_id: 'it-1',
		billing_period_start: '2026-10-01',
		billing_period_end: '2026-10-31',
		quantity_source: 'consumption',
		invoice_id: 'inv',
		invoice_number: 'F-3',
		status: 'Por Emitir',
		is_active: true,
		issue_date: '2026-11-01',
		document_type: 'FACTURA',
		invoice_type: 'Automatica',
		is_legacy: false,
	};

	it('junta las filas de una misma factura, ítem y período: cantidad del período, Σ subtotal y desglose en orden; las single pasan tal cual', () => {
		const grouped = groupConsumptionLines([
			{
				...base,
				line_id: 'l-c',
				quantity: 1,
				subtotal: -8.7,
				pricing_breakdown: [{ kind: 'discount', quantity: 0, amount: -8.7, label: 'D', period_quantity: 1250, line_index: 2, line_count: 3 }],
			},
			{
				...base,
				line_id: 'l-a',
				quantity: 400,
				subtotal: 42,
				pricing_breakdown: [{ kind: 'tier', quantity: 400, amount: 42, label: 'T1', period_quantity: 1250, line_index: 0, line_count: 3 }],
			},
			{
				...base,
				line_id: 'l-b',
				quantity: 750,
				subtotal: 45,
				pricing_breakdown: [{ kind: 'tier', quantity: 750, amount: 45, label: 'T2', period_quantity: 1250, line_index: 1, line_count: 3 }],
			},
			{ ...base, line_id: 'l-single', invoice_id: 'inv-old', status: 'Cancelada', quantity: 1000, subtotal: 64.8, pricing_breakdown: null },
		]);

		expect(grouped).toHaveLength(2);
		expect(grouped[0]).toMatchObject({ line_id: 'l-a', line_ids: ['l-a', 'l-b', 'l-c'], quantity: 1250, subtotal: 78.3 });
		expect(grouped[0].pricing_breakdown?.map((subline) => subline.label)).toEqual(['T1', 'T2', 'D']);
		expect(grouped[1]).toMatchObject({ line_id: 'l-single', line_ids: ['l-single'], quantity: 1000, subtotal: 64.8 });
	});

	it('buildConsumption (Domi 05-10): suma la complementaria sin marca, omite períodos cancelados y anulados con NC, y la NC nunca representa el período', () => {
		const items = [
			{
				id: 'it-1',
				product_name: 'Rutas',
				account: null,
				quantity: 18,
				unit_of_measure: 'vehículo',
				price: { quantity_type: 'metered' } as never,
				metric: null,
			},
		];
		const line = (patch: Record<string, unknown>) => ({ ...base, pricing_breakdown: null, ...patch }) as never;
		const result = buildConsumption({
			today: '2026-10-05',
			entries: [],
			items,
			lines: [
				// Julio: original + complementaria del front anterior (sin sublínea `invoiced`).
				line({
					line_id: 'j1',
					billing_period_start: '2026-07-01',
					billing_period_end: '2026-07-31',
					invoice_id: 'f-808',
					invoice_number: 'FAC 027808',
					status: 'Vencida',
					issue_date: '2026-08-10',
					quantity: 19,
					subtotal: 14.25,
				}),
				line({
					line_id: 'j2',
					billing_period_start: '2026-07-01',
					billing_period_end: '2026-07-31',
					invoice_id: 'f-844',
					invoice_number: 'FAC 027844',
					status: 'Vencida',
					issue_date: '2026-08-19',
					quantity: 4.42,
					subtotal: 3.32,
				}),
				// Agosto: anulada con NC (flujo viejo: las dos Canceladas).
				line({
					line_id: 'a1',
					billing_period_start: '2026-08-01',
					billing_period_end: '2026-08-31',
					invoice_id: 'f-716',
					invoice_number: 'FAC 027716',
					status: 'Cancelada',
					issue_date: '2026-08-30',
					quantity: 18,
					subtotal: 15.3,
				}),
				line({
					line_id: 'a2',
					billing_period_start: '2026-08-01',
					billing_period_end: '2026-08-31',
					invoice_id: 'nc-1877',
					invoice_number: 'NC 1877',
					document_type: 'NC',
					credit_type: 'cancellation',
					status: 'Cancelada',
					issue_date: '2026-08-31',
					quantity: 18,
					subtotal: -15.3,
				}),
				// Septiembre: Por Emitir cancelada al terminar el contrato.
				line({
					line_id: 's1',
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					invoice_id: 'f-sep',
					invoice_number: null,
					status: 'Cancelada',
					issue_date: '2026-09-01',
					quantity: 18,
					subtotal: 15.3,
				}),
				// Octubre: Cancelada "sin cobro" (consumo 0): sigue siendo el período y acepta consumo.
				line({
					line_id: 'o1',
					billing_period_start: '2026-10-01',
					billing_period_end: '2026-10-31',
					invoice_id: 'f-oct',
					invoice_number: null,
					status: 'Cancelada',
					no_charge: true,
					issue_date: '2026-11-01',
					quantity: 0,
					subtotal: 0,
				}),
			],
		});
		const periods = result.items[0].periods;

		expect(periods.map((period) => period.period_start)).toEqual(['2026-07-01', '2026-10-01']);
		expect(periods[0]).toMatchObject({ quantity: 23.42, amount: 17.57, invoice: { id: 'f-808' } });
		expect(periods[0].invoices.map((invoice) => [invoice.number, invoice.is_complementary])).toEqual([
			['FAC 027808', false],
			['FAC 027844', true],
		]);
		expect(periods[1]).toMatchObject({ amount: 0, invoice: { id: 'f-oct', no_charge: true } });
	});

	it('buildConsumption: la entry con invoice_id se cruza con esa factura y marca la complementaria con la emitida a la que complementa', () => {
		const items = [{ id: 'it-1', product_name: 'Rutas', account: null, quantity: 1000, unit_of_measure: 'ruta', price: null, metric: null }];
		const entry = {
			id: 'e1',
			contract_item_id: 'it-1',
			period_start: '2026-10-01',
			period_end: '2026-10-31',
			quantity: 1250,
			amount_override: null,
			apply_item_discount: true,
			account: null,
			is_estimated: false,
			source: 'manual',
			revision: 1,
			correction_reason: null,
			notes: null,
			idempotency_key: null,
			invoice_id: 'inv-comp',
			created_at: null,
			updated_at: null,
			revisions_count: 1,
			recorded_by: null,
			recorded_at: null,
			revisions: [],
		};
		const result = buildConsumption({
			today: '2026-12-01',
			entries: [entry],
			items,
			lines: [
				{
					...base,
					line_id: 'l-paid',
					invoice_id: 'inv-paid',
					invoice_number: 'F-0042',
					status: 'Pagada',
					quantity: 1000,
					subtotal: 64.8,
					pricing_breakdown: null,
				},
				{
					...base,
					line_id: 'l-comp',
					invoice_id: 'inv-comp',
					invoice_number: null,
					quantity: 250,
					subtotal: 13.5,
					pricing_breakdown: [{ kind: 'invoiced', quantity: 1000, amount: -64.8, label: 'Ya facturado en F-0042', invoice_id: 'inv-paid' }],
				},
			],
		});

		// El monto es el del período completo (decisión de Domi 05-10): la emitida más su complementaria, con las dos facturas.
		expect(result.rows[0]).toMatchObject({
			quantity: 1250,
			amount: 78.3,
			invoice: { id: 'inv-comp', status: 'Por Emitir', is_complementary: true, complements_invoice_id: 'inv-paid' },
		});
		expect(result.rows[0].invoices.map((invoice) => [invoice.id, invoice.is_complementary])).toEqual([
			['inv-paid', false],
			['inv-comp', true],
		]);
		expect(result.items[0].periods[0]).toMatchObject({ quantity: 1250, amount: 78.3 });
		// Sin invoice_id en la entry, gana la Por Emitir vigente igual; una emitida normal no es complementaria.
		const plain = buildConsumption({
			today: '2026-12-01',
			entries: [{ ...entry, invoice_id: null }],
			items,
			lines: [
				{
					...base,
					line_id: 'l-paid',
					invoice_id: 'inv-paid',
					invoice_number: 'F-0042',
					status: 'Pagada',
					quantity: 1000,
					subtotal: 64.8,
					pricing_breakdown: null,
				},
			],
		});

		expect(plain.rows[0].invoice).toMatchObject({
			id: 'inv-paid',
			number: 'F-0042',
			status: 'Pagada',
			issue_date: '2026-11-01',
			is_complementary: false,
			complements_invoice_id: null,
		});
	});
});

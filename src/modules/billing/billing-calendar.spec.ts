import {
	addDays,
	BEFORE_KEY,
	buildCalendar,
	CALENDAR_CELL_ITEMS,
	calendarAmountOf,
	type CalendarInvoiceRow,
	calendarPeriods,
	calendarStateOf,
	mondayOf,
	periodKeyOf,
} from './billing-calendar';

const row = (overrides: Partial<CalendarInvoiceRow>): CalendarInvoiceRow => ({
	id: 'i1',
	invoice_number: 'F-1',
	client_id: 'c1',
	client_name: 'Acme',
	contract_id: 'k1',
	contract_number: 'C-1',
	date: '2026-10-05',
	currency: 'CLP',
	amount: 1000,
	amount_system: 1,
	state: 'issued',
	...overrides,
});

describe('calendario: columnas', () => {
	it('mes, semana (lunes a domingo) y día, sin UTC local', () => {
		expect(periodKeyOf('2026-10-15', 'month')).toBe('2026-10');
		expect(mondayOf('2026-10-04')).toBe('2026-09-28');
		expect(mondayOf('2026-10-05')).toBe('2026-10-05');
		expect(periodKeyOf('2026-10-07', 'week')).toBe('2026-10-05');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
	});

	it('por defecto 12 meses, 12 semanas o 21 días desde la columna de inicio', () => {
		const months = calendarPeriods('2026-10-15', null, 'month');

		expect(months).toHaveLength(12);
		expect(months[0]).toEqual({ key: '2026-10', start: '2026-10-01', end: '2026-10-31' });
		expect(months[11].key).toBe('2027-09');
		expect(months[4]).toEqual({ key: '2027-02', start: '2027-02-01', end: '2027-02-28' });
		const weeks = calendarPeriods('2026-10-07', null, 'week');

		expect(weeks).toHaveLength(12);
		expect(weeks[0]).toEqual({ key: '2026-10-05', start: '2026-10-05', end: '2026-10-11' });
		expect(calendarPeriods('2026-10-07', null, 'day')).toHaveLength(21);
	});

	it('rango explícito; inverso o demasiado largo → error', () => {
		expect(calendarPeriods('2026-01-10', '2026-03-02', 'month').map((period) => period.key)).toEqual(['2026-01', '2026-02', '2026-03']);
		expect(() => calendarPeriods('2026-03-01', '2026-01-01', 'month')).toThrow('anterior');
		expect(() => calendarPeriods('2026-01-01', '2028-06-01', 'month')).toThrow('hasta 24');
		expect(() => calendarPeriods('2026-01-01', '2026-04-01', 'day')).toThrow('hasta 62');
	});
});

describe('calendario: estado de una factura', () => {
	it.each([
		[{ status: 'Cancelada', document_kind: 'invoice', payment_state: 'not_applicable', is_overdue: false }, 'cancelled'],
		[{ status: 'Emitida', document_kind: 'credit_note', payment_state: 'not_applicable', is_overdue: false }, 'credit_note'],
		[{ status: 'Por Emitir', document_kind: 'invoice', payment_state: 'not_applicable', is_overdue: false }, 'to_issue'],
		[{ status: 'Pagada', document_kind: 'invoice', payment_state: 'paid', is_overdue: false }, 'paid'],
		[{ status: 'Emitida', document_kind: 'invoice', payment_state: 'overdue', is_overdue: true }, 'overdue'],
		[{ status: 'Enviada', document_kind: 'invoice', payment_state: 'unpaid', is_overdue: false }, 'issued'],
	])('%o → %s', (input, state) => {
		expect(calendarStateOf(input)).toBe(state);
	});
});

describe('calendario: agregación', () => {
	const periods = calendarPeriods('2026-10-01', '2026-12-31', 'month');

	it('celdas por cliente y mes con monto por moneda (sin mezclar), sistema, estados y totales por columna y fila', () => {
		const result = buildCalendar(
			[
				row({ id: 'a', date: '2026-10-05', amount: 1000, amount_system: 1.1 }),
				row({ id: 'b', date: '2026-10-20', currency: 'USD', amount: 50, amount_system: 50, state: 'overdue' }),
				row({
					id: 'c',
					date: '2026-11-01',
					currency: 'CLF',
					amount: 15,
					amount_system: null,
					state: 'to_issue',
					in_contract_currency: true,
					invoice_currency: 'CLP',
				}),
				row({ id: 'd', client_id: 'c2', client_name: 'Beta', date: '2026-12-31', amount: 10, amount_system: 0.01 }),
				row({ id: 'fuera', date: '2027-01-01' }),
			],
			periods,
			{ granularity: 'month', groupBy: 'client' }
		);

		expect(result.periods.map((period) => period.key)).toEqual(['2026-10', '2026-11', '2026-12']);
		expect(result.rows.map((group) => group.client_name)).toEqual(['Acme', 'Beta']);
		const october = result.rows[0].cells['2026-10'];

		expect(october).toMatchObject({
			invoices: 2,
			by_currency: [
				{ currency: 'CLP', amount: 1000, invoices: 1 },
				{ currency: 'USD', amount: 50, invoices: 1 },
			],
			system: 51.1,
			unconverted: 0,
			by_state: { issued: 1, overdue: 1 },
		});
		expect(october.items.map((item) => item.id)).toEqual(['a', 'b']);
		// No emitida en otra moneda de contrato: cuenta en la moneda del contrato (suma a "Total CLF"), no al sistema si no tiene monto en él.
		expect(result.rows[0].cells['2026-11']).toMatchObject({
			invoices: 1,
			unconverted: 1,
			system: 0,
			in_contract_currency: 1,
			by_currency: [{ currency: 'CLF', amount: 15, invoices: 1 }],
		});
		expect(result.rows[0].cells['2026-11'].items[0]).toMatchObject({ id: 'c', in_contract_currency: true, invoice_currency: 'CLP', amount: 15 });
		expect(result.rows[0].totals).toMatchObject({ invoices: 3, system: 51.1, unconverted: 1, in_contract_currency: 1 });
		expect(result.totals['2026-12']).toMatchObject({ invoices: 1, system: 0.01 });
		expect(result.grand_total).toMatchObject({
			invoices: 4,
			by_currency: [
				{ currency: 'CLF', amount: 15, invoices: 1 },
				{ currency: 'CLP', amount: 1010, invoices: 2 },
				{ currency: 'USD', amount: 50, invoices: 1 },
			],
		});
		expect(result.grand_total).not.toHaveProperty('unvalued');
	});

	it('moneda con que cuenta: emitida en la de la factura; no emitida en la del contrato (total con IVA o, sin tipo de cambio, el neto)', () => {
		const base = { invoice_currency: 'CLP', contract_currency: 'UF', amount_contract: 10, total_contract: null, total_due: null };

		expect(calendarAmountOf({ ...base, status: 'Emitida', total_due: 450000 })).toEqual({
			currency: 'CLP',
			amount: 450000,
			in_contract_currency: false,
		});
		expect(calendarAmountOf({ ...base, status: 'Por Emitir' })).toEqual({ currency: 'UF', amount: 10, in_contract_currency: true });
		expect(calendarAmountOf({ ...base, status: 'Por Emitir', total_due: 450000, total_contract: 11.9 })).toEqual({
			currency: 'UF',
			amount: 11.9,
			in_contract_currency: true,
		});
		// Misma moneda: su total; sin total aún, el neto (nunca 0 ni "sin valorizar").
		expect(calendarAmountOf({ ...base, contract_currency: 'clp', status: 'Por Emitir', total_due: 1190 })).toEqual({
			currency: 'CLP',
			amount: 1190,
			in_contract_currency: false,
		});
		expect(calendarAmountOf({ ...base, contract_currency: 'CLP', status: 'Por Emitir' })).toEqual({
			currency: 'CLP',
			amount: 10,
			in_contract_currency: false,
		});
	});

	it('las anteriores al rango van en la columna "before" (cola); por contrato separa filas del mismo cliente', () => {
		const result = buildCalendar(
			[
				row({ id: 'late', date: '2026-08-15', state: 'late' }),
				row({ id: 'k2', contract_id: 'k2', contract_number: 'C-2', date: '2026-10-02', state: 'ready' }),
			],
			periods,
			{ granularity: 'month', groupBy: 'contract' }
		);

		expect(result.periods[0]).toMatchObject({ key: BEFORE_KEY, kind: 'before', end: '2026-09-30' });
		expect(result.rows.map((group) => group.contract_number)).toEqual(['C-1', 'C-2']);
		expect(result.rows[0].cells[BEFORE_KEY]).toMatchObject({ invoices: 1, by_state: { late: 1 } });
		expect(result.totals[BEFORE_KEY].invoices).toBe(1);
	});

	it('detalle por celda acotado; el conteo sigue completo', () => {
		const many = Array.from({ length: CALENDAR_CELL_ITEMS + 5 }, (_, index) => row({ id: `x${index}` }));
		const cell = buildCalendar(many, periods, { granularity: 'month', groupBy: 'client' }).rows[0].cells['2026-10'];

		expect(cell.items).toHaveLength(CALENDAR_CELL_ITEMS);
		expect(cell.invoices).toBe(CALENDAR_CELL_ITEMS + 5);
	});

	it('semanas y días', () => {
		const weeks = buildCalendar([row({ date: '2026-10-07' })], calendarPeriods('2026-10-01', '2026-10-31', 'week'), {
			granularity: 'week',
			groupBy: 'client',
		});

		expect(Object.keys(weeks.rows[0].cells)).toEqual(['2026-10-05']);
		const days = buildCalendar([row({ date: '2026-10-07' })], calendarPeriods('2026-10-01', '2026-10-10', 'day'), {
			granularity: 'day',
			groupBy: 'client',
		});

		expect(Object.keys(days.rows[0].cells)).toEqual(['2026-10-07']);
		expect(days.periods).toHaveLength(10);
	});
});

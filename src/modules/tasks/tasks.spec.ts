// `TasksService` arrastra el scheduler de facturas (uuid ESM): se simula como en los otros specs.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { buildTasks, monthBounds, type TaskInputs } from './tasks';
import { TasksService } from './tasks.service';

const zero = { count: 0, amount: null };
const inputs = (extra: Partial<TaskInputs> = {}): TaskInputs => ({
	today: '2026-10-03',
	currency: 'USD',
	queue: { ready: zero, late: zero, blocked: { ...zero, reasons: [] }, past_months: { ...zero, first_month: null } },
	overdue: zero,
	credit_notes: zero,
	proposals: zero,
	expired: zero,
	pacts: zero,
	consumptions: zero,
	without_invoices: zero,
	starts: zero,
	waiting_mapping: zero,
	quotes_unprocessed: zero,
	revenue_exceptions: zero,
	...extra,
});

describe('tareas (Notificaciones v2 §4)', () => {
	it('mes del día: primero, último y anterior', () => {
		expect(monthBounds('2026-10-03')).toEqual({ first: '2026-10-01', last: '2026-10-31', month: '2026-10', previousMonth: '2026-09' });
		expect(monthBounds('2026-01-15').previousMonth).toBe('2025-12');
		expect(monthBounds('2028-02-10').last).toBe('2028-02-29');
	});

	it('arma todas las tareas, ordenadas por gravedad, con enlaces a las pantallas filtradas del front nuevo', () => {
		const tasks = buildTasks(
			inputs({
				queue: {
					ready: { count: 3, amount: 900 },
					late: { count: 1, amount: 10 },
					blocked: { count: 2, amount: 50, reasons: [{ code: 'fx_rate_missing', label: 'Falta el tipo de cambio', count: 2 }] },
					past_months: { count: 1, amount: 10, first_month: '2026-07' },
				},
				expired: { count: 1, contract_ids: ['c-1'] },
				proposals: { count: 2, contract_ids: ['c-1', 'c-2'] },
				consumptions: { count: 4, contract_ids: ['c-9'] },
				quotes_unprocessed: { count: 2, amount: 300, currency: 'CLP' },
			})
		);
		const byKey = Object.fromEntries(tasks.map((task) => [task.key, task]));

		expect(tasks).toHaveLength(15);
		expect(tasks[0].severity).toBe('error');
		expect(byKey.invoices_to_issue_today).toMatchObject({
			count: 3,
			amount: 900,
			currency: 'USD',
			href: '/lab/facturacion?estado=Por+Emitir&grupo=ready',
		});
		expect(byKey.invoices_blocked.breakdown).toEqual([
			{
				key: 'fx_rate_missing',
				label: 'Falta el tipo de cambio',
				count: 2,
				href: '/lab/facturacion?estado=Por+Emitir&grupo=blocked&periodo=todo&motivo=fx_rate_missing',
			},
		]);
		expect(byKey.invoices_past_months.href).toBe('/lab/facturacion?estado=Por+Emitir&desde=2026-07&hasta=2026-09');
		expect(byKey.invoices_overdue.href).toBe('/lab/facturacion?pago=overdue&periodo=todo');
		expect(byKey.credit_notes_to_issue).toMatchObject({
			amount: null,
			currency: null,
			href: '/lab/facturacion?tab=notas-credito&dte=pending_emission&periodo=todo',
		});
		// Un solo contrato → su 360; varios → la lista filtrada.
		expect(byKey.expirations_without_decision.href).toBe('/lab/contratos/c-1');
		expect(byKey.renewals_to_decide.href).toBe('/lab/contratos?f=estado:pending_renewal');
		expect(byKey.consumptions_to_report.href).toBe('/lab/contratos/c-9?tab=consumos');
		expect(byKey.service_starts_this_month.href).toBe('/lab/contratos?f=inicio_desde:2026-10-01;inicio_hasta:2026-10-31');
		expect(byKey.quotes_unprocessed_this_month).toMatchObject({
			amount: 300,
			currency: 'CLP',
			href: '/lab/cotizaciones?f=booking_desde:2026-10-01;booking_hasta:2026-10-31;con_contrato:no;estado:signed',
		});
		expect(byKey.revenue_exceptions).toMatchObject({ module: 'ingresos', module_label: 'Ingresos', href: '/lab/revenue?tab=excepciones' });
	});

	describe('TasksService', () => {
		const build = (overrides: { queue?: unknown; failContracts?: boolean } = {}) => {
			const query = jest.fn(async (sql: string, ...rest: unknown[]) => {
				void rest;
				if (sql.includes('amount_system_currency, COALESCE(issue_date')) {
					return [
						{ id: 'i-ready', amount_system_currency: '100', date: '2026-10-03' },
						{ id: 'i-blocked', amount_system_currency: '50', date: '2026-08-15' },
						{ id: 'i-late', amount_system_currency: '20', date: '2026-10-01' },
					];
				}
				if (sql.includes('d.is_overdue')) return [{ overdue: '2', overdue_amount: '123.456', credit_notes: '1' }];
				if (sql.includes('WITH live AS')) {
					if (overrides.failContracts) throw new Error('timeout');
					return [
						{
							expired: '1',
							expired_ids: ['c-1'],
							proposals: '0',
							pacts: '0',
							without_invoices: '3',
							starts: '5',
							renew_30: '1',
							renew_90: '4',
							expired_contracts: '2',
						},
					];
				}
				if (sql.includes('salesforce_opportunities_stg')) return [{ n: '2' }];
				if (sql.includes('FROM quotes q')) return [{ n: '1', currencies: '1', currency: 'USD', amount: '500' }];
				return [];
			});
			const billing = {
				today: jest.fn().mockResolvedValue('2026-10-03'),
				systemCurrency: jest.fn().mockResolvedValue('USD'),
				queue: jest.fn().mockResolvedValue(
					overrides.queue ?? {
						entries: [
							{ id: 'i-ready', group: 'ready', blocked_reasons: [] },
							{ id: 'i-blocked', group: 'blocked', blocked_reasons: [{ code: 'needs_reference', message: 'Falta la OC' }] },
							{ id: 'i-late', group: 'late', blocked_reasons: [] },
						],
						truncated: false,
					}
				),
			};
			const consumption = {
				pending: jest.fn().mockResolvedValue({ total: 2, data: [{ contract: { id: 'c-7' } }, { contract: { id: 'c-7' } }] }),
			};
			const revenue = { exceptions: jest.fn().mockResolvedValue({ items: 4 }) };
			const service = new TasksService({ query } as never, billing as never, consumption as never, revenue as never);

			return { service, query, billing, consumption, revenue };
		};

		it('junta las fuentes de cada módulo (cola Por emitir hasta hoy, vencidas, contratos, cotizaciones, consumos, excepciones)', async () => {
			const { service, billing, query } = build();
			const result = await service.forHolding('holding-1');
			const byKey = Object.fromEntries(result.tasks.map((task) => [task.key, task]));

			expect(billing.queue).toHaveBeenCalledWith('holding-1', {}, '2026-10-03', { until: '2026-10-03' });
			expect(byKey.invoices_to_issue_today).toMatchObject({ count: 1, amount: 100 });
			expect(byKey.invoices_blocked).toMatchObject({ count: 1, amount: 50 });
			expect(byKey.invoices_blocked.breakdown).toEqual([expect.objectContaining({ key: 'needs_reference', count: 1 })]);
			expect(byKey.invoices_past_months).toMatchObject({ count: 1, href: '/lab/facturacion?estado=Por+Emitir&desde=2026-08&hasta=2026-09' });
			expect(byKey.invoices_overdue).toMatchObject({ count: 2, amount: 123.46 });
			expect(byKey.expirations_without_decision.href).toBe('/lab/contratos/c-1');
			expect(byKey.consumptions_to_report).toMatchObject({ count: 2, href: '/lab/contratos/c-7?tab=consumos' });
			expect(byKey.quotes_waiting_mapping.count).toBe(2);
			expect(byKey.quotes_unprocessed_this_month).toMatchObject({ count: 1, amount: 500, currency: 'USD' });
			expect(byKey.revenue_exceptions.count).toBe(4);
			expect(result.dashboard).toEqual({ renew_30: 1, renew_90: 4, expired_contracts: 2, invoices_to_emit: 3 });
			for (const [, params] of query.mock.calls as Array<[string, unknown[]]>) expect(params[0]).toBe('holding-1');
		});

		it('una fuente que falla deja su tarea en cero sin tumbar el resto; pending() solo devuelve las con conteo', async () => {
			const { service } = build({ failContracts: true });
			const pending = await service.pending('holding-1', '2026-10-03');

			expect(pending.tasks.map((task) => task.key)).not.toContain('expirations_without_decision');
			expect(pending.tasks.map((task) => task.key)).toContain('invoices_overdue');
			expect(pending.tasks.every((task) => task.count > 0)).toBe(true);
		});
	});
});

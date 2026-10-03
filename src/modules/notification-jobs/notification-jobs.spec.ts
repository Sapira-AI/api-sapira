// `TasksService` arrastra el scheduler de facturas (uuid ESM): se simula como en los otros specs.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { localParts, mondayOf, money, signedMoney, weekLabel } from './local-time';
import { MonthCloseService } from './month-close.service';
import { NotificationDigestService } from './notification-digest.service';
import { NotificationJobsScheduler } from './notification-jobs.scheduler';

describe('hora local del holding', () => {
	it('partes en la zona del holding (lunes 08:00 en Santiago = 11:00 UTC en octubre)', () => {
		expect(localParts(new Date('2026-10-05T11:30:00Z'), 'America/Santiago')).toEqual({ date: '2026-10-05', weekday: 1, hour: 8 });
		expect(localParts(new Date('2026-10-05T11:30:00Z'), 'America/Mexico_City')).toMatchObject({ hour: 5 });
		expect(localParts(new Date('2026-10-05T11:30:00Z'), 'Zona/Inventada')).toMatchObject({ hour: 8 });
		expect(mondayOf('2026-10-08')).toBe('2026-10-05');
		expect(mondayOf('2026-10-05')).toBe('2026-10-05');
		expect(mondayOf('2026-10-11')).toBe('2026-10-05');
		expect(weekLabel('2026-10-05')).toBe('Semana del 5 de octubre de 2026');
		expect(money(12345.6, 'USD')).toBe('USD 12.346');
		expect(signedMoney(-300, 'USD')).toBe('−USD 300');
	});
});

describe('aviso de cierre de mes (contrato §8.6)', () => {
	const build = (rows: Array<Record<string, unknown>>, open: Array<{ id: string; deduplication_key: string | null }> = []) => {
		const tasks = { monthCloseByCompany: jest.fn().mockResolvedValue(rows), currency: jest.fn().mockResolvedValue('USD') };
		const notifications = {
			listOpen: jest.fn().mockResolvedValue(open),
			resolveOpen: jest.fn(async (_holding: string, criteria: { ids?: string[] }) => criteria.ids?.length ?? 0),
			createOrUpdate: jest.fn().mockResolvedValue({ notification: { id: 'n-1' }, recipient_count: 2 }),
		};

		return { service: new MonthCloseService(tasks as never, notifications as never), tasks, notifications };
	};

	it('en la ventana: una alerta por compañía con la acción a la cola y "Mover al mes siguiente"', async () => {
		const { service, notifications } = build(
			[
				{ company_id: 'co-1', company_name: 'Acme SpA', count: 3, amount: 1500, invoice_ids: ['i-1', 'i-2', 'i-3'] },
				{ company_id: 'co-2', company_name: 'Beta', count: 0, amount: 0, invoice_ids: [] },
			],
			[
				{ id: 'old', deduplication_key: 'month-close:2026-09:co-1' },
				{ id: 'same', deduplication_key: 'month-close:2026-10:co-1' },
			]
		);

		await expect(service.run('h-1', '2026-11-03')).resolves.toEqual({ month: '2026-10', alerts: 1, resolved: 1 });
		expect(notifications.createOrUpdate).toHaveBeenCalledTimes(1);
		const [, dto] = notifications.createOrUpdate.mock.calls[0];

		expect(dto).toMatchObject({
			type: 'month_close_pending',
			company_id: 'co-1',
			title: '3 facturas Por Emitir de octubre de 2026 siguen sin emitir · Acme SpA',
			action_type: 'open_billing_queue',
			escalation_step: '2026-10:2',
			deduplication_key: 'month-close:2026-10:co-1',
		});
		expect(dto.message).toContain('USD 1.500');
		expect(dto.action_payload).toMatchObject({
			month: '2026-10',
			href: '/lab/facturacion?estado=Por+Emitir&desde=2026-10&hasta=2026-10&company_id=co-1',
			secondary: {
				type: 'move_to_next_month',
				label: 'Mover al mes siguiente',
				endpoint: '/billing/to-issue/reschedule',
				body: { invoice_ids: ['i-1', 'i-2', 'i-3'], shift_months: 1 },
				complete: true,
			},
		});
		expect(notifications.resolveOpen).toHaveBeenCalledWith('h-1', { ids: ['old'] });
	});

	it('fuera de la ventana cierra las abiertas y no consulta la cola', async () => {
		const { service, notifications, tasks } = build([], [{ id: 'a', deduplication_key: 'month-close:2026-10:co-1' }]);

		await expect(service.run('h-1', '2026-11-12')).resolves.toEqual({ month: null, alerts: 0, resolved: 1 });
		expect(tasks.monthCloseByCompany).not.toHaveBeenCalled();
		expect(notifications.createOrUpdate).not.toHaveBeenCalled();
	});
});

describe('resumen semanal (contrato §8.4)', () => {
	const build = (route: (sql: string, params: unknown[]) => unknown = () => undefined) => {
		const query = jest.fn(async (sql: string, params: unknown[] = []) => {
			const routed = route(sql, params);

			if (routed !== undefined) return routed;
			if (sql.includes('holding_settings')) return [{ timezone: 'America/Santiago' }];
			if (sql.includes('FROM company_holdings')) return [{ name: 'Hanka' }];

			return [];
		});
		const tasks = {
			pending: jest.fn().mockResolvedValue({
				tasks: [
					{
						module_label: 'Facturación',
						title: 'Facturas por emitir hoy',
						count: 2,
						href: '/lab/facturacion?estado=Por+Emitir&grupo=ready',
					},
				],
			}),
		};
		const mrr = {
			overview: jest.fn().mockResolvedValue({ currency: 'USD', kpis: { mrr: { value: 10000, previous: 9500, delta: 500 } } }),
			movementDetail: jest.fn().mockResolvedValue({
				data: [
					{ client_name: 'Acme', amount: 800 },
					{ client_name: 'Beta', amount: -300 },
					{ client_name: null, amount: 50 },
				],
			}),
			byDimension: jest.fn().mockResolvedValue({
				currency: 'USD',
				rows: [
					{ key: 'co-1', total: 7000 },
					{ key: 'co-2', total: 3000 },
				],
			}),
		};
		const notifications = { myCompanies: jest.fn().mockResolvedValue([]) };
		const emails = {
			enabled: true,
			appUrl: jest.fn((path: string) => `https://app.test${path}`),
			alertUrl: jest.fn((id: string) => `https://app.test/lab/notificaciones?alerta=${id}`),
			logoUrl: jest.fn(() => undefined),
			deliver: jest.fn().mockResolvedValue('sent'),
		};
		const service = new NotificationDigestService({ query } as never, tasks as never, mrr as never, notifications as never, emails as never);

		return { service, query, tasks, mrr, notifications, emails };
	};

	it('destinatarios: preferencia guardada o default (Administrador y Finanzas)', async () => {
		const { service } = build((sql) =>
			sql.includes('FROM user_holdings uh')
				? [
						{ id: 'u-1', email: 'a@x.cl', name: 'Ana', role_name: 'Administrador', digest: null },
						{ id: 'u-2', email: 'v@x.cl', name: 'Vale', role_name: 'Ventas', digest: null },
						{ id: 'u-3', email: 'f@x.cl', name: 'Fer', role_name: 'Finanzas', digest: false },
						{ id: 'u-4', email: 'o@x.cl', name: 'Oli', role_name: 'Operaciones', digest: true },
					]
				: undefined
		);

		expect((await service.recipients('h-1')).map((user) => user.id)).toEqual(['u-1', 'u-4']);
	});

	it('arma el correo con tareas, MRR (aumentos y pérdidas) y renovaciones, respetando "Mis compañías"', async () => {
		const { service, tasks, mrr, notifications } = build((sql) => {
			if (sql.includes("upper(e.event_type) = 'RENEWAL'"))
				return [{ id: 'c-1', contract_number: 'CTR-1', name_commercial: 'Acme', total: '1' }];
			if (sql.includes('FROM app_notification_recipients r')) return [{ id: 'n-1', title: 'Falló el envío', severity: 'error' }];
			if (sql.includes('legal_name FROM companies')) return [{ legal_name: 'Acme SpA' }];
			return undefined;
		});

		notifications.myCompanies.mockResolvedValue(['co-1']);
		const email = await service.build(
			'h-1',
			{ id: 'u-1', email: 'a@x.cl', name: 'Ana', role_name: 'Administrador' },
			new Date('2026-10-05T11:30:00Z')
		);

		expect(tasks.pending).toHaveBeenCalledWith('h-1', '2026-10-05', ['co-1']);
		expect(mrr.overview).toHaveBeenCalledWith('h-1', { asOf: '2026-10', companyId: 'co-1' });
		expect(mrr.movementDetail).toHaveBeenCalledWith(
			'h-1',
			expect.objectContaining({ from: '2026-10', to: '2026-10', groupBy: 'client', companyId: 'co-1' })
		);
		expect(email.subject).toBe('Tu resumen semanal de Sapira · Hanka');
		expect(email.html).toContain('Semana del 5 de octubre de 2026');
		expect(email.html).toContain('Facturas por emitir hoy');
		expect(email.html).toContain('+USD 800');
		expect(email.html).toContain('−USD 300');
		expect(email.html).toContain('CTR-1 · Acme');
		expect(email.html).toContain('Falló el envío');
		expect(email.text).toContain('Incluye solo tus compañías: Acme SpA.');
	});

	it('"Por compañía": con varias compañías con datos, tareas (sin las de todo el holding), alertas de la semana y MRR por compañía', async () => {
		const { service, tasks, mrr } = build((sql) => {
			if (sql.includes('id::text AS id, legal_name FROM companies'))
				return [
					{ id: 'co-1', legal_name: 'Acme <SpA>' },
					{ id: 'co-2', legal_name: 'Beta Ltda' },
					{ id: 'co-3', legal_name: 'Vacía SA' },
				];
			if (sql.includes('FROM app_notification_recipients r'))
				return [
					{ id: 'n-1', title: 'Falló el envío', severity: 'error', company_id: 'co-1' },
					{ id: 'n-2', title: 'Tipo de cambio', severity: 'warning', company_id: null },
				];
			return undefined;
		});

		tasks.pending.mockImplementation(async (_holding: string, _today: string, companies: string[]) => ({
			tasks:
				companies[0] === 'co-1'
					? [
							{ key: 'invoices_blocked', module_label: 'Facturación', title: 'Bloqueadas', count: 2, href: '/lab/facturacion' },
							{ key: 'invoices_late', module_label: 'Facturación', title: 'Atrasadas', count: 1, href: '/lab/facturacion' },
							// No distingue compañía: no se suma.
							{ key: 'revenue_exceptions', module_label: 'Ingresos', title: 'Excepciones', count: 9, href: '/lab/revenue' },
						]
					: companies[0] === 'co-2'
						? [{ key: 'invoices_late', module_label: 'Facturación', title: 'Atrasadas', count: 1, href: '/lab/facturacion' }]
						: [],
		}));
		mrr.byDimension.mockResolvedValue({
			currency: 'USD',
			rows: [
				{ key: 'co-1', total: 7000 },
				{ key: 'co-2', total: 3000 },
			],
		});
		const email = await service.build(
			'h-1',
			{ id: 'u-1', email: 'a@x.cl', name: 'Ana', role_name: 'Administrador' },
			new Date('2026-10-05T11:30:00Z')
		);

		expect(mrr.byDimension).toHaveBeenCalledWith(
			'h-1',
			expect.objectContaining({ dimension: 'company', from: '2026-10', to: '2026-10', companyId: 'co-1,co-2,co-3' })
		);
		expect(tasks.pending).toHaveBeenCalledWith('h-1', '2026-10-05', ['co-2']);
		expect(email.html).toContain('Por compañía');
		expect(email.html).toContain('Acme &lt;SpA&gt;');
		expect(email.html).not.toContain('Acme <SpA>');
		expect(email.text).toContain('- Acme <SpA>: 3 tareas · 1 alerta · MRR USD 7.000');
		expect(email.text).toContain('- Beta Ltda: 1 tarea · 0 alertas · MRR USD 3.000');
		expect(email.text).not.toContain('Vacía SA');
	});

	it('"Por compañía" no aparece si solo una compañía tiene datos', async () => {
		const { service, tasks, mrr } = build((sql) =>
			sql.includes('id::text AS id, legal_name FROM companies')
				? [
						{ id: 'co-1', legal_name: 'Acme SpA' },
						{ id: 'co-2', legal_name: 'Beta Ltda' },
					]
				: undefined
		);

		tasks.pending.mockImplementation(async (_holding: string, _today: string, companies: string[]) => ({
			tasks: companies[0] === 'co-2' ? [] : [{ key: 'invoices_late', module_label: 'Facturación', title: 'Atrasadas', count: 1, href: '/x' }],
		}));
		mrr.byDimension.mockResolvedValue({ currency: 'USD', rows: [{ key: 'co-1', total: 7000 }] });
		const email = await service.build(
			'h-1',
			{ id: 'u-1', email: 'a@x.cl', name: 'Ana', role_name: 'Administrador' },
			new Date('2026-10-05T11:30:00Z')
		);

		expect(email.html).not.toContain('Por compañía');
	});

	it('envío idempotente por semana: clave digest:<holding>:<lunes>', async () => {
		const { service, emails } = build((sql) =>
			sql.includes('FROM user_holdings uh') ? [{ id: 'u-1', email: 'a@x.cl', name: 'Ana', role_name: 'Finanzas', digest: null }] : undefined
		);

		await expect(service.run('h-1', new Date('2026-10-07T12:00:00Z'))).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
		expect(emails.deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'digest', key: 'digest:h-1:2026-10-05', to: 'a@x.cl' }));
	});
});

describe('job horario de notificaciones', () => {
	const build = (env: Record<string, string> = {}) => {
		const query = jest.fn().mockResolvedValue([
			{ id: 'h-cl', timezone: 'America/Santiago' },
			{ id: 'h-mx', timezone: 'America/Mexico_City' },
		]);
		const digest = { run: jest.fn().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 }) };
		const monthClose = { run: jest.fn().mockResolvedValue({ month: null, alerts: 0, resolved: 0 }) };
		const config = { get: jest.fn((key: string) => env[key]) };
		const emails = { sendDueAlerts: jest.fn().mockResolvedValue({ sent: 2, failed: 0, discarded: 1, skipped: 0 }) };
		const scheduler = new NotificationJobsScheduler({ query } as never, config as never, digest as never, monthClose as never, emails as never);

		return { scheduler, digest, monthClose, emails };
	};

	it('a las 07 locales corre el cierre de mes; los lunes a las 08 locales, el resumen (cada holding en su zona)', async () => {
		const { scheduler, digest, monthClose } = build();

		// Lunes 5 de octubre de 2026, 10:05 UTC = 07:05 en Santiago (UTC-3) y 04:05 en Ciudad de México.
		await scheduler.hourly(new Date('2026-10-05T10:05:00Z'));
		expect(monthClose.run).toHaveBeenCalledWith('h-cl', '2026-10-05');
		expect(digest.run).not.toHaveBeenCalled();

		await scheduler.hourly(new Date('2026-10-05T11:05:00Z'));
		expect(digest.run).toHaveBeenCalledWith('h-cl', expect.any(Date));
		expect(digest.run).not.toHaveBeenCalledWith('h-mx', expect.anything());

		// 14:05 UTC = 08:05 en Ciudad de México (UTC-6).
		await scheduler.hourly(new Date('2026-10-05T14:05:00Z'));
		expect(digest.run).toHaveBeenCalledWith('h-mx', expect.any(Date));
	});

	it('NOTIFICATION_JOBS_ENABLED=false lo apaga', async () => {
		const { scheduler, digest, monthClose } = build({ NOTIFICATION_JOBS_ENABLED: 'false' });

		await expect(scheduler.hourly(new Date('2026-10-05T11:05:00Z'))).resolves.toBeNull();
		expect(digest.run).not.toHaveBeenCalled();
		expect(monthClose.run).not.toHaveBeenCalled();
	});

	it('cada 15 minutos envía las alertas por correo que cumplieron la ventana (no depende de NOTIFICATION_JOBS_ENABLED)', async () => {
		const { scheduler, emails } = build({ NOTIFICATION_JOBS_ENABLED: 'false' });
		const now = new Date('2026-10-05T11:10:00Z');

		await expect(scheduler.alertEmails(now)).resolves.toEqual({ sent: 2, failed: 0, discarded: 1, skipped: 0 });
		expect(emails.sendDueAlerts).toHaveBeenCalledWith(now);
	});
});

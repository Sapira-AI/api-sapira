import { renderAlertEmail } from '@/auth/accounts/email-templates/alert';
import { renderDigestEmail } from '@/auth/accounts/email-templates/digest';

import { NotificationEmailService } from './notification-email.service';

type Route = (sql: string, params: unknown[]) => unknown;

const build = (route: Route = () => undefined, env: Record<string, string> = {}) => {
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		const routed = route(sql, params);

		if (routed !== undefined) return routed;
		if (sql.includes('INSERT INTO notification_email_log')) return [{ id: 'log-1' }];
		if (sql.includes('holding_name')) return [{ holding_name: 'Hanka', company_name: 'Acme SpA' }];

		return [];
	});
	const mailer = {
		sendRendered: jest.fn().mockResolvedValue({ status: 'sent', id: 'resend-1' }),
		appUrl: jest.fn((path: string) => `https://app.test${path}`),
		brandLogoUrl: jest.fn(() => undefined),
	};
	const config = { get: jest.fn((key: string) => env[key]) };
	const service = new NotificationEmailService({ query } as never, mailer as never, config as never);

	return { service, query, mailer };
};

const users = (rows: Array<Record<string, unknown>>) => (sql: string) => (sql.includes('FROM users u LEFT JOIN roles') ? rows : undefined);
const alert = {
	id: 'n-1',
	holding_id: 'h-1',
	type: 'invoice_odoo_failure',
	severity: 'error' as const,
	title: 'No se pudo enviar la factura 12 de <Acme>',
	message: 'El ERP rechazó la factura',
	recommendation: 'Corrige el RUT',
	company_id: 'co-1',
	metadata: {},
};

describe('NotificationEmailService (correo inmediato, contrato §8.3)', () => {
	const insertOf = (query: jest.Mock) => query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notification_email_log'))!;

	it('reserva (sin enviar) solo para quien quiere correo: preferencia guardada o default (error + Administrador)', async () => {
		const { service, mailer, query } = build((sql) => {
			if (sql.includes('FROM users u LEFT JOIN roles'))
				return [
					{ id: 'u-admin', email: 'admin@x.cl', name: 'Ana', role_name: 'Administrador', is_super_admin: false },
					{ id: 'u-fin', email: 'fin@x.cl', name: 'Fer', role_name: 'Finanzas', is_super_admin: false },
					{ id: 'u-off', email: 'off@x.cl', name: 'Olga', role_name: 'Administrador', is_super_admin: false },
				];
			if (sql.includes('SELECT user_id, email FROM user_notification_preferences')) return [{ user_id: 'u-off', email: false }];
			return undefined;
		});

		await expect(service.queueAlert(alert, ['u-admin', 'u-fin', 'u-off'])).resolves.toBe(1);
		expect(mailer.sendRendered).not.toHaveBeenCalled();
		expect(insertOf(query)[1]).toEqual(['h-1', 'u-admin', 'alert:n-1:error:0', 'n-1', false]);
		// Sin escalamiento no reemplaza reservas.
		expect(query.mock.calls.some(([sql]) => String(sql).includes(`status = 'failed'`))).toBe(false);
	});

	it('deduplica: si la fila ya existe no reserva otra; las alertas de varios holdings usan su grupo', async () => {
		const admin = [{ id: 'u-1', email: 'a@x.cl', name: null, role_name: 'Administrador', is_super_admin: true }];
		const { service, query } = build((sql) => {
			if (sql.includes('INSERT INTO notification_email_log')) return [];
			return users(admin)(sql);
		});

		await expect(
			service.queueAlert({ ...alert, type: 'fx_sync_failure', metadata: { email_group: 'fx-sync-failure:2026-10-03' } }, ['u-1'], {
				escalated: true,
			})
		).resolves.toBe(0);
		expect(insertOf(query)[1][2]).toBe('alert-group:fx-sync-failure:2026-10-03');
		// La misma clave (grupo) no reemplaza la reserva pendiente.
		expect(query.mock.calls.some(([sql]) => String(sql).includes(`status = 'failed'`))).toBe(false);
	});

	it('escalamiento en la ventana: nueva clave con el created_at de la reserva pendiente, que queda reemplazada (sale una sola vez)', async () => {
		const { service, query } = build(users([{ id: 'u-1', email: 'a@x.cl', name: null, role_name: 'Administrador', is_super_admin: false }]));

		await service.queueAlert({ ...alert, metadata: { escalation_step: 7 } }, ['u-1'], { escalated: true });
		const [sql, params] = insertOf(query);

		expect(params).toEqual(['h-1', 'u-1', 'alert:n-1:error:7', 'n-1', true]);
		expect(sql).toContain('MIN(p.created_at)');
		const superseded = query.mock.calls.find(([text]) => String(text).includes(`SET status = 'failed', error = $4`))!;

		expect(superseded[1]).toEqual(['u-1', 'n-1', 'log-1', 'reemplazada por escalamiento']);
	});

	it('NOTIFICATION_EMAILS_ENABLED=false apaga la reserva y el envío', async () => {
		const off = build(users([{ id: 'u-1', email: 'a@x.cl', role_name: 'Administrador' }]), { NOTIFICATION_EMAILS_ENABLED: 'false' });

		await expect(off.service.queueAlert(alert, ['u-1'])).resolves.toBe(0);
		await expect(off.service.sendDueAlerts(new Date())).resolves.toEqual({ sent: 0, failed: 0, discarded: 0, skipped: 0 });
		expect(off.query).not.toHaveBeenCalled();
	});

	it('ventana configurable: NOTIFICATION_EMAIL_DELAY_MINUTES (default 15; inválido vuelve al default)', () => {
		expect(build().service.delayMinutes).toBe(15);
		expect(build(undefined, { NOTIFICATION_EMAIL_DELAY_MINUTES: '30' }).service.delayMinutes).toBe(30);
		expect(build(undefined, { NOTIFICATION_EMAIL_DELAY_MINUTES: '0' }).service.delayMinutes).toBe(0);
		expect(build(undefined, { NOTIFICATION_EMAIL_DELAY_MINUTES: 'x' }).service.delayMinutes).toBe(15);
		expect(build(undefined, { NOTIFICATION_EMAIL_DELAY_MINUTES: '-5' }).service.delayMinutes).toBe(15);
	});

	describe('sendDueAlerts (job cada 5 minutos)', () => {
		const pending = [
			{
				id: 'log-open',
				user_id: 'u-1',
				dedup_key: 'alert:n-1:error:0',
				notification_id: 'n-1',
				email: 'a@x.cl',
				user_status: 'Activo',
				escalated: false,
			},
			{
				id: 'log-esc',
				user_id: 'u-2',
				dedup_key: 'alert:n-1:error:7',
				notification_id: 'n-1',
				email: 'b@x.cl',
				user_status: 'Activo',
				escalated: true,
			},
			{
				id: 'log-res',
				user_id: 'u-1',
				dedup_key: 'alert:n-2:error:0',
				notification_id: 'n-2',
				email: 'a@x.cl',
				user_status: 'Activo',
				escalated: false,
			},
			{
				id: 'log-del',
				user_id: 'u-1',
				dedup_key: 'alert:n-3:error:0',
				notification_id: null,
				email: 'a@x.cl',
				user_status: 'Activo',
				escalated: false,
			},
			{
				id: 'log-off',
				user_id: 'u-3',
				dedup_key: 'alert:n-1:error:0',
				notification_id: 'n-1',
				email: 'c@x.cl',
				user_status: 'Inactivo',
				escalated: false,
			},
		];
		const route =
			(taken: (id: string) => boolean = () => true) =>
			(sql: string, params: unknown[]) => {
				if (sql.includes('FROM notification_email_log l')) return pending;
				if (sql.includes('FROM app_notifications WHERE id = ANY'))
					return [
						{ ...alert, status: 'open' },
						{ ...alert, id: 'n-2', status: 'resolved' },
					];
				if (sql.includes('SET sent_at = now()')) return taken(String(params[0])) ? [{ id: params[0] }] : [];
				return undefined;
			};

		it('envía las que cumplieron la ventana con la alerta abierta; descarta resueltas, borradas y usuarios inactivos', async () => {
			const { service, query, mailer } = build(route());
			const now = new Date('2026-10-03T12:00:00Z');

			await expect(service.sendDueAlerts(now)).resolves.toEqual({ sent: 2, failed: 0, discarded: 3, skipped: 0 });
			const select = query.mock.calls.find(([sql]) => String(sql).includes('FROM notification_email_log l'))!;

			expect(select[0]).toContain(`l.kind = 'alert' AND l.status = 'pending' AND l.sent_at IS NULL AND l.created_at <= $1`);
			expect(select[1][0]).toEqual(new Date('2026-10-03T11:45:00Z'));
			const discards = query.mock.calls.filter(([sql]) => String(sql).includes(`SET status = 'failed', error = $2`));

			expect(discards.map(([, params]) => params)).toEqual([
				['log-res', 'resuelta antes de enviar'],
				['log-del', 'resuelta antes de enviar'],
				['log-off', 'usuario inactivo o sin correo'],
			]);
			expect(mailer.sendRendered).toHaveBeenCalledTimes(2);
			expect(mailer.sendRendered.mock.calls[0][0]).toBe('a@x.cl');
			expect(mailer.sendRendered.mock.calls[0][1].subject).toBe('[Bloquea] No se pudo enviar la factura 12 de <Acme>');
			expect(mailer.sendRendered.mock.calls[0][1].html).toContain('No se pudo enviar la factura 12 de &lt;Acme&gt;');
			expect(mailer.sendRendered.mock.calls[0][1].html).toContain('https://app.test/lab/notificaciones?alerta=n-1');
			expect(mailer.sendRendered.mock.calls[0][2]).toBe('notif:u-1:alert:n-1:error:0');
			// Escaló dentro de la ventana: una sola vez, con el asunto de escalamiento.
			expect(mailer.sendRendered.mock.calls[1][1].subject).toBe('[Bloquea] Sigue pendiente: No se pudo enviar la factura 12 de <Acme>');
			const done = query.mock.calls.filter(([sql]) => String(sql).includes('SET status = $2, provider_id = $3'));

			expect(done.map(([, params]) => params)).toEqual([
				['log-open', 'sent', 'resend-1', null],
				['log-esc', 'sent', 'resend-1', null],
			]);
		});

		it('otra réplica ya tomó la fila: no la envía; un fallo de Resend queda registrado sin lanzar', async () => {
			const { service, mailer, query } = build(route((id) => id !== 'log-open'));

			mailer.sendRendered.mockResolvedValue({ status: 'failed', error: 'HTTP 500' });
			await expect(service.sendDueAlerts(new Date())).resolves.toEqual({ sent: 0, failed: 1, discarded: 3, skipped: 1 });
			const done = query.mock.calls.find(([sql]) => String(sql).includes('SET status = $2, provider_id = $3'))!;

			expect(done[1]).toEqual(['log-esc', 'failed', null, 'HTTP 500']);
		});

		it('respeta la ventana configurada', async () => {
			const { service, query } = build(() => [], { NOTIFICATION_EMAIL_DELAY_MINUTES: '30' });

			await service.sendDueAlerts(new Date('2026-10-03T12:00:00Z'));
			expect(query.mock.calls[0][1][0]).toEqual(new Date('2026-10-03T11:30:00Z'));
		});
	});

	it('respaldo a direcciones (variables viejas): misma plantilla, botón al centro', async () => {
		const { service, mailer } = build();

		await expect(service.sendAlertToAddresses(['ops@sapira.ai', 'leon@sapira.ai'], { ...alert, id: 'k' }, 'fallback:k')).resolves.toBe(2);
		expect(mailer.sendRendered.mock.calls[0][1].html).toContain('https://app.test/lab/notificaciones');
		expect(mailer.sendRendered.mock.calls[0][1].html).not.toContain('alerta=k');
	});
});

describe('plantillas de marca de Notificaciones', () => {
	it('alerta: gravedad, Qué pasó, Qué hacer, Qué hacemos nosotros y texto plano equivalente', () => {
		const email = renderAlertEmail({
			severityLabel: 'Atención',
			typeLabel: 'Facturas del mes sin emitir',
			moduleLabel: 'Facturación',
			title: '3 facturas Por Emitir de octubre siguen sin emitir',
			whatHappened: 'Quedan 3 por "USD 1.200"',
			whatToDo: 'Emítelas o muévelas',
			whatWeDo: 'Te avisamos 3 días',
			url: 'https://app.test/lab/notificaciones?alerta=x',
		});

		expect(email.html).toContain('Qué pasó');
		expect(email.html).toContain('Qué hacemos nosotros');
		expect(email.html).toContain('&quot;USD 1.200&quot;');
		expect(email.text).toContain('QUÉ HACER');
		expect(email.text).toContain('Ver alerta: https://app.test/lab/notificaciones?alerta=x');
	});

	it('resumen semanal: omite secciones vacías y colorea aumentos y pérdidas', () => {
		const email = renderDigestEmail({
			name: 'Domi',
			holdingName: 'Hanka',
			weekLabel: 'Semana del 5 de octubre de 2026',
			url: 'https://app.test/lab/notificaciones',
			tasks: [{ module: 'Facturación', title: 'Facturas por emitir hoy', count: 3, url: 'https://app.test/lab/facturacion' }],
			alerts: { total: 0, items: [] },
			mrr: {
				month: 'octubre de 2026',
				previousMonth: 'septiembre de 2026',
				value: 'USD 10.000',
				previous: 'USD 9.000',
				delta: '+USD 1.000',
				deltaTone: 'up',
				increases: [{ label: 'Acme', value: '+USD 800' }],
				decreases: [{ label: 'Beta <script>', value: '−USD 100' }],
			},
			renewals: { count: 0, items: [] },
		});

		expect(email.subject).toBe('Tu resumen semanal de Sapira · Hanka');
		expect(email.html).toContain('Tareas abiertas');
		expect(email.html).not.toContain('Alertas abiertas');
		expect(email.html).not.toContain('Renovaciones ejecutadas');
		expect(email.html).toContain('#0F7A3E');
		expect(email.html).toContain('#B42318');
		expect(email.html).toContain('Beta &lt;script&gt;');
	});
});

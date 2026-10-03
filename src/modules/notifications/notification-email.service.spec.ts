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
	it('envía solo a quien quiere correo: preferencia guardada o default (error + Administrador)', async () => {
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

		await expect(service.sendAlert(alert, ['u-admin', 'u-fin', 'u-off'])).resolves.toBe(1);
		expect(mailer.sendRendered).toHaveBeenCalledTimes(1);
		expect(mailer.sendRendered.mock.calls[0][0]).toBe('admin@x.cl');
		const log = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notification_email_log'))!;

		expect(log[1]).toEqual(['h-1', 'u-admin', 'alert', 'alert:n-1:error:0', 'n-1']);
		const email = mailer.sendRendered.mock.calls[0][1];

		expect(email.subject).toBe('[Bloquea] No se pudo enviar la factura 12 de <Acme>');
		expect(email.html).toContain('No se pudo enviar la factura 12 de &lt;Acme&gt;');
		expect(email.html).not.toContain('<Acme>');
		expect(email.html).toContain('https://app.test/lab/notificaciones?alerta=n-1');
		expect(email.html).toContain('Acme SpA');
	});

	it('deduplica: si la fila ya existe no reenvía; las alertas de varios holdings usan su grupo', async () => {
		const admin = [{ id: 'u-1', email: 'a@x.cl', name: null, role_name: 'Administrador', is_super_admin: true }];
		const { service, mailer, query } = build((sql) => {
			if (sql.includes('INSERT INTO notification_email_log')) return [];
			return users(admin)(sql);
		});

		await expect(
			service.sendAlert({ ...alert, type: 'fx_sync_failure', metadata: { email_group: 'fx-sync-failure:2026-10-03' } }, ['u-1'])
		).resolves.toBe(0);
		expect(mailer.sendRendered).not.toHaveBeenCalled();
		expect(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notification_email_log'))![1][3]).toBe(
			'alert-group:fx-sync-failure:2026-10-03'
		);
	});

	it('escalamiento: la clave lleva gravedad y escalón (vuelve a salir) y el asunto lo dice', async () => {
		const { service, mailer, query } = build(
			users([{ id: 'u-1', email: 'a@x.cl', name: null, role_name: 'Administrador', is_super_admin: false }])
		);

		await service.sendAlert({ ...alert, metadata: { escalation_step: 7 } }, ['u-1'], { escalated: true });
		expect(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO notification_email_log'))![1][3]).toBe('alert:n-1:error:7');
		expect(mailer.sendRendered.mock.calls[0][1].subject).toBe('[Bloquea] Sigue pendiente: No se pudo enviar la factura 12 de <Acme>');
	});

	it('NOTIFICATION_EMAILS_ENABLED=false apaga todo; un fallo de Resend queda registrado sin lanzar', async () => {
		const off = build(users([{ id: 'u-1', email: 'a@x.cl', role_name: 'Administrador' }]), { NOTIFICATION_EMAILS_ENABLED: 'false' });

		await expect(off.service.sendAlert(alert, ['u-1'])).resolves.toBe(0);
		expect(off.query).not.toHaveBeenCalled();

		const failing = build(users([{ id: 'u-1', email: 'a@x.cl', role_name: 'Administrador' }]));

		failing.mailer.sendRendered.mockResolvedValue({ status: 'failed', error: 'HTTP 500' });
		await expect(failing.service.sendAlert(alert, ['u-1'])).resolves.toBe(0);
		const update = failing.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE notification_email_log'))!;

		expect(update[1]).toEqual(['log-1', 'failed', null, 'HTTP 500']);
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

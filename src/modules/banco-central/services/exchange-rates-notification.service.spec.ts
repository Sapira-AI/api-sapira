import { ExchangeRatesNotificationService } from './exchange-rates-notification.service';

const build = (env: Record<string, string> = {}, created = true) => {
	const notifications = {
		createOrUpdate: jest
			.fn()
			.mockResolvedValue(created ? { notification: { id: 'n-1' }, recipient_count: 2 } : { notification: null, recipient_count: 0 }),
		resolveByDeduplicationKey: jest.fn(),
	};
	const emails = { sendAlertToAddresses: jest.fn().mockResolvedValue(1) };
	const config = { get: jest.fn((key: string) => env[key]) };
	const query = jest.fn().mockResolvedValue([{ id: 'h-1' }, { id: 'h-2' }]);
	const service = new ExchangeRatesNotificationService(config as never, notifications as never, emails as never, { query } as never);

	return { service, notifications, emails };
};

describe('avisos de tipos de cambio (contrato §8.5)', () => {
	it('falla → fx_sync_failure en todos los holdings, un correo por día por usuario (email_group), sin trazas', async () => {
		const { service, notifications, emails } = build();
		const error = new Error('timeout\n    at x (y:1:1)');

		await service.sendSyncFailureAlert(error, 'Sincronización automática diaria');
		expect(notifications.createOrUpdate).toHaveBeenCalledTimes(2);
		const [holding, dto] = notifications.createOrUpdate.mock.calls[0];

		expect(holding).toBe('h-1');
		expect(dto).toMatchObject({
			type: 'fx_sync_failure',
			severity: 'error',
			deduplication_key: 'fx-sync-failure',
			action_type: 'review_fx_rates',
		});
		expect(dto.metadata.email_group).toMatch(/^fx-sync-failure:\d{4}-\d{2}-\d{2}$/);
		expect(dto.metadata.error_message).toBe('timeout at x (y:1:1)');
		expect(emails.sendAlertToAddresses).not.toHaveBeenCalled();
	});

	it('sin destinatarios en ningún holding → respaldo a BANCO_CENTRAL_ADMIN_EMAILS', async () => {
		const { service, emails } = build({ BANCO_CENTRAL_ADMIN_EMAILS: 'leon@aisapira.com' }, false);

		await service.sendSyncFailureAlert(new Error('caída'));
		expect(emails.sendAlertToAddresses).toHaveBeenCalledWith(
			['leon@aisapira.com'],
			expect.objectContaining({ type: 'fx_sync_failure' }),
			expect.any(String)
		);
	});

	it('éxito → cierra las alertas abiertas y ya no envía correo de reporte', async () => {
		const { service, notifications, emails } = build({ BANCO_CENTRAL_SEND_SUCCESS_REPORT: 'true' });

		await service.sendSyncSuccessReport();
		expect(notifications.resolveByDeduplicationKey).toHaveBeenCalledWith('h-1', 'fx-sync-failure');
		expect(notifications.resolveByDeduplicationKey).toHaveBeenCalledWith('h-2', 'fx-sync-failure');
		expect(emails.sendAlertToAddresses).not.toHaveBeenCalled();
	});

	it('correo de prueba solo a quien lo pide', async () => {
		const { service, emails, notifications } = build();

		await service.sendTestFailureEmail('domi@aisapira.com');
		expect(emails.sendAlertToAddresses).toHaveBeenCalledWith(
			['domi@aisapira.com'],
			expect.objectContaining({ title: expect.stringContaining('Prueba') }),
			expect.any(String)
		);
		expect(notifications.createOrUpdate).not.toHaveBeenCalled();
	});
});

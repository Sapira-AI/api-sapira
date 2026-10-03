import { InvoiceNotificationService } from './invoice-notification.service';

const build = (env: Record<string, string> = {}, created = true) => {
	const notifications = {
		createOrUpdate: jest
			.fn()
			.mockResolvedValue(created ? { notification: { id: 'n-1' }, recipient_count: 2 } : { notification: null, recipient_count: 0 }),
		resolveOpen: jest.fn().mockResolvedValue(1),
	};
	const emails = { sendAlertToAddresses: jest.fn().mockResolvedValue(1) };
	const config = { get: jest.fn((key: string) => env[key]) };

	return { service: new InvoiceNotificationService(notifications as never, emails as never, config as never), notifications, emails };
};
const invoice = { id: 'inv-1', holding_id: 'h-1', company_id: 'co-1', contract_id: 'c-1', invoice_number: 'F-12' } as never;
const summary = (errors: number) =>
	({
		jobId: 'job-1',
		holdingId: 'h-1',
		dryRun: false,
		executionSource: 'automatic',
		executionEnvironment: 'production',
		startedAt: new Date('2026-10-03T12:00:00Z'),
		result: { summary: { total: 10, sent: 10 - errors, errors, skipped: 0 }, results: [], executedAt: new Date('2026-10-03T12:05:00Z') },
		distinctErrors: errors ? [{ message: 'RUT inválido', count: errors }] : [],
	}) as never;

describe('correos internos de facturación como alertas (contrato §8.5)', () => {
	it('tasa de respaldo → invoice_fx_fallback de la factura (compañía y acción a la factura), deduplicada por par', async () => {
		const { service, notifications, emails } = build();

		await service.sendExchangeRateFallbackNotification(invoice, {
			rate: 950.5,
			requestedDate: new Date('2026-10-03T00:00:00Z'),
			usedDate: '2026-10-02',
			fromCurrency: 'USD',
			toCurrency: 'CLP',
		});
		expect(notifications.createOrUpdate).toHaveBeenCalledWith(
			'h-1',
			expect.objectContaining({
				type: 'invoice_fx_fallback',
				severity: 'warning',
				company_id: 'co-1',
				resource_type: 'invoice',
				resource_id: 'inv-1',
				action_type: 'open_invoice',
				deduplication_key: 'invoice-fx-fallback:inv-1:USD>CLP',
			})
		);
		expect(notifications.createOrUpdate.mock.calls[0][1].message).toContain('del 2026-10-02 (950.5)');
		expect(emails.sendAlertToAddresses).not.toHaveBeenCalled();
	});

	it('sin destinatarios cae al respaldo INVOICE_ADMIN_EMAILS con la plantilla de marca', async () => {
		const { service, emails } = build({ INVOICE_ADMIN_EMAILS: 'domi@aisapira.com, leon@aisapira.com' }, false);

		await service.sendMissingExchangeRateNotification(invoice, new Date('2026-10-03T00:00:00Z'), 'CLF', 'CLP');
		expect(emails.sendAlertToAddresses).toHaveBeenCalledWith(
			['domi@aisapira.com', 'leon@aisapira.com'],
			expect.objectContaining({ type: 'invoice_fx_missing', severity: 'error', holding_id: 'h-1' }),
			'fallback:invoice-fx-missing:inv-1:CLF>CLP'
		);
	});

	it('resumen del scheduler: con errores una alerta por holding y día; sin errores cierra; dryRun no avisa', async () => {
		const { service, notifications } = build();

		await service.sendSchedulerErrorSummary(summary(3));
		expect(notifications.createOrUpdate).toHaveBeenCalledWith(
			'h-1',
			expect.objectContaining({
				type: 'scheduler_error_summary',
				title: 'La emisión automática terminó con 3 facturas con error',
				deduplication_key: 'scheduler-errors:h-1:2026-10-03',
			})
		);
		expect(notifications.createOrUpdate.mock.calls[0][1].message).toContain('RUT inválido (3)');

		await service.sendSchedulerErrorSummary(summary(0));
		expect(notifications.resolveOpen).toHaveBeenCalledWith('h-1', { type: 'scheduler_error_summary' });

		notifications.createOrUpdate.mockClear();
		await service.sendSchedulerErrorSummary({ ...(summary(2) as object), dryRun: true } as never);
		expect(notifications.createOrUpdate).not.toHaveBeenCalled();
	});

	it('cierra "no emitida por falta de tasa" al enviarse la factura; nunca lanza', async () => {
		const { service, notifications } = build();

		await service.resolveMissingExchangeRate('h-1', 'inv-1');
		expect(notifications.resolveOpen).toHaveBeenCalledWith('h-1', { type: 'invoice_fx_missing', resourceId: 'inv-1' });
		notifications.createOrUpdate.mockRejectedValue(new Error('db caída'));
		await expect(service.sendMissingExchangeRateNotification(invoice, new Date(), 'USD', 'CLP')).resolves.toBeUndefined();
	});
});

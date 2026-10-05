import { InvoiceSchedulerScheduler } from './invoice-scheduler.scheduler';

// `uuid` publica ESM y Jest no lo transforma (llega por `AppLoggerService`).
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

/**
 * El cron nocturno crea **una corrida por holding** (pedido de Leon, 27-09-2026). Antes creaba un solo
 * job sin holding, que quedaba como `holdingId: 'all'` con las facturas de todos los clientes mezcladas.
 */
const HOLDING_A = '11111111-1111-4111-8111-111111111111';
const HOLDING_B = '22222222-2222-4222-8222-222222222222';

const okResult = (total = 1) => ({
	success: true,
	dryRun: false,
	summary: { total, sent: total, errors: 0, skipped: 0 },
	results: [],
	executedAt: new Date(),
});

function buildScheduler(holdingIds: string[] = [HOLDING_A, HOLDING_B], config: { hour?: number; enabled?: boolean } = {}) {
	const service = {
		getHoldingIdsWithPendingInvoices: jest.fn().mockResolvedValue(holdingIds),
		createSystemSchedulerJob: jest.fn(async ({ holdingId }: { holdingId?: string }) => `job-${holdingId}`),
		processInvoicesToSend: jest.fn().mockResolvedValue(okResult()),
		updateSchedulerJobResult: jest.fn(),
		updateSchedulerJobError: jest.fn(),
	};
	// El cron solo corre en la hora configurada: por defecto, la actual.
	const configService = {
		get: jest.fn((key: string) => {
			if (key === 'INVOICE_SCHEDULER_HOUR') return String(config.hour ?? new Date().getHours());
			if (key === 'INVOICE_SCHEDULER_ENABLED') return config.enabled === false ? 'false' : 'true';
			return undefined;
		}),
	};
	const appLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

	const scheduler = new InvoiceSchedulerScheduler(service as never, configService as never, appLogger as never);
	jest.spyOn(scheduler['logger'], 'log').mockImplementation();
	jest.spyOn(scheduler['logger'], 'warn').mockImplementation();
	jest.spyOn(scheduler['logger'], 'error').mockImplementation();

	return { scheduler, service, appLogger };
}

describe('InvoiceSchedulerScheduler', () => {
	afterEach(() => jest.restoreAllMocks());

	it('crea una corrida por holding con facturas pendientes, cada una acotada a su holding', async () => {
		const { scheduler, service } = buildScheduler();

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.createSystemSchedulerJob).toHaveBeenCalledTimes(2);
		expect(service.createSystemSchedulerJob).toHaveBeenNthCalledWith(1, { dryRun: false, holdingId: HOLDING_A });
		expect(service.createSystemSchedulerJob).toHaveBeenNthCalledWith(2, { dryRun: false, holdingId: HOLDING_B });
		expect(service.processInvoicesToSend).toHaveBeenNthCalledWith(1, { dryRun: false, holdingId: HOLDING_A });
		expect(service.processInvoicesToSend).toHaveBeenNthCalledWith(2, { dryRun: false, holdingId: HOLDING_B });
	});

	it('cierra cada job con su propio resultado', async () => {
		const { scheduler, service } = buildScheduler();

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.updateSchedulerJobResult).toHaveBeenCalledTimes(2);
		expect(service.updateSchedulerJobResult.mock.calls.map(([jobId]) => jobId)).toEqual([`job-${HOLDING_A}`, `job-${HOLDING_B}`]);
		expect(service.updateSchedulerJobError).not.toHaveBeenCalled();
	});

	it('un holding que falla no aborta los siguientes', async () => {
		const { scheduler, service } = buildScheduler();
		service.processInvoicesToSend.mockRejectedValueOnce(new Error('Odoo caído')).mockResolvedValueOnce(okResult());

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.updateSchedulerJobError).toHaveBeenCalledTimes(1);
		expect(service.updateSchedulerJobError.mock.calls[0][0]).toBe(`job-${HOLDING_A}`);
		// El segundo holding igual se procesó y cerró bien.
		expect(service.processInvoicesToSend).toHaveBeenCalledTimes(2);
		expect(service.updateSchedulerJobResult).toHaveBeenCalledTimes(1);
		expect(service.updateSchedulerJobResult.mock.calls[0][0]).toBe(`job-${HOLDING_B}`);
	});

	it('sin holdings pendientes no crea ninguna corrida', async () => {
		const { scheduler, service } = buildScheduler([]);

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.createSystemSchedulerJob).not.toHaveBeenCalled();
		expect(service.processInvoicesToSend).not.toHaveBeenCalled();
	});

	it('no corre fuera de la hora configurada', async () => {
		const { scheduler, service } = buildScheduler([HOLDING_A], { hour: (new Date().getHours() + 1) % 24 });

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.getHoldingIdsWithPendingInvoices).not.toHaveBeenCalled();
	});

	it('no corre si el scheduler está deshabilitado por configuración', async () => {
		const { scheduler, service } = buildScheduler([HOLDING_A], { enabled: false });

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.getHoldingIdsWithPendingInvoices).not.toHaveBeenCalled();
	});

	it('no se solapa con una corrida en curso', async () => {
		const { scheduler, service } = buildScheduler();
		scheduler['isRunning'] = true;

		await scheduler.sendInvoicesToOdooDaily();

		expect(service.getHoldingIdsWithPendingInvoices).not.toHaveBeenCalled();
	});

	it('libera el candado aunque falle la consulta de holdings', async () => {
		const { scheduler, service } = buildScheduler();
		service.getHoldingIdsWithPendingInvoices.mockRejectedValue(new Error('Postgres caído'));

		await scheduler.sendInvoicesToOdooDaily();

		expect(scheduler['isRunning']).toBe(false);
	});
});

jest.mock('@/logger/app-logger.service', () => ({
	AppLoggerService: class AppLoggerService {},
}));

import { ExchangeRatesScheduler } from './exchange-rates.scheduler';

describe('ExchangeRatesScheduler', () => {
	const createScheduler = () => {
		const exchangeRatesService = {
			syncExchangeRates: jest.fn(),
		};
		const notificationService = {
			sendSyncSuccessReport: jest.fn(),
			sendSyncFailureAlert: jest.fn(),
		};
		const configService = {
			get: jest.fn((key: string) => {
				if (key === 'BANCO_CENTRAL_SYNC_ENABLED') return 'true';
				if (key === 'BANCO_CENTRAL_SYNC_HOUR') return '8';
				return undefined;
			}),
		};
		const appLogger = {
			log: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};

		const scheduler = new ExchangeRatesScheduler(
			exchangeRatesService as any,
			notificationService as any,
			configService as any,
			appLogger as any
		);

		jest.spyOn(scheduler as any, 'formatLocalDate').mockReturnValue('2026-07-10');
		jest.spyOn(scheduler as any, 'sleep').mockResolvedValue(undefined);

		return {
			scheduler,
			exchangeRatesService,
			notificationService,
		};
	};

	it('reintenta cuando la sincronización devuelve pares fallidos y luego se recupera', async () => {
		const { scheduler, exchangeRatesService } = createScheduler();

		exchangeRatesService.syncExchangeRates
			.mockResolvedValueOnce({
				success: false,
				message: 'Sincronización completada con errores parciales en 2 pares de monedas',
				stats: {
					totalProcessed: 3,
					inserted: 0,
					updated: 3,
					errors: 2,
					indirectConversions: 0,
				},
				failedCurrencyPairs: ['USD/BRL', 'USD/PEN'],
				monthlyAveragesCalculated: { periods: 1, currencyPairs: 3 },
			})
			.mockResolvedValueOnce({
				success: true,
				message: 'Sincronización completada exitosamente',
				stats: {
					totalProcessed: 9,
					inserted: 0,
					updated: 9,
					errors: 0,
					indirectConversions: 1,
				},
				failedCurrencyPairs: [],
				monthlyAveragesCalculated: { periods: 1, currencyPairs: 9 },
			});

		const result = await (scheduler as any).syncWithRetries(3);

		expect(exchangeRatesService.syncExchangeRates).toHaveBeenCalledTimes(2);
		expect((scheduler as any).sleep).toHaveBeenCalledTimes(1);
		expect((scheduler as any).sleep).toHaveBeenCalledWith(5 * 60 * 1000);
		expect(result.failedCurrencyPairs).toEqual([]);
		expect(result.success).toBe(true);
	});

	it('no reintenta si solo existen errores de observaciones pero no pares fallidos', async () => {
		const { scheduler, exchangeRatesService } = createScheduler();

		exchangeRatesService.syncExchangeRates.mockResolvedValueOnce({
			success: true,
			message: 'Sincronización completada exitosamente',
			stats: {
				totalProcessed: 5,
				inserted: 0,
				updated: 5,
				errors: 2,
				indirectConversions: 0,
			},
			failedCurrencyPairs: [],
			monthlyAveragesCalculated: { periods: 1, currencyPairs: 5 },
		});

		const result = await (scheduler as any).syncWithRetries(3);

		expect(exchangeRatesService.syncExchangeRates).toHaveBeenCalledTimes(1);
		expect((scheduler as any).sleep).not.toHaveBeenCalled();
		expect(result.stats.errors).toBe(2);
	});

	it('lanza error cuando se agotan los reintentos con pares fallidos', async () => {
		const { scheduler, exchangeRatesService } = createScheduler();

		exchangeRatesService.syncExchangeRates.mockResolvedValue({
			success: false,
			message: 'Sincronización completada con errores parciales en 1 par de monedas',
			stats: {
				totalProcessed: 3,
				inserted: 0,
				updated: 3,
				errors: 1,
				indirectConversions: 0,
			},
			failedCurrencyPairs: ['USD/BRL'],
			monthlyAveragesCalculated: { periods: 1, currencyPairs: 3 },
		});

		await expect((scheduler as any).syncWithRetries(2)).rejects.toThrow(
			'No se pudo completar la sincronización de tipos de cambio tras 2 intentos. Pares con fallo: USD/BRL'
		);
		expect(exchangeRatesService.syncExchangeRates).toHaveBeenCalledTimes(2);
		expect((scheduler as any).sleep).toHaveBeenCalledTimes(1);
		expect((scheduler as any).sleep).toHaveBeenCalledWith(5 * 60 * 1000);
	});
});

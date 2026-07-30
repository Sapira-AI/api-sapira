import { PeruApiController } from './peru-api.controller';

describe('PeruApiController', () => {
	const exchangeRatesService = {
		getExchangeRates: jest.fn(),
		syncExchangeRates: jest.fn(),
	};
	const controller = new PeruApiController(exchangeRatesService as any);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('sincroniza únicamente USD/PEN', async () => {
		exchangeRatesService.syncExchangeRates.mockResolvedValue({ success: true });

		await controller.syncExchangeRates({
			startDate: '2026-06-01',
			endDate: '2026-06-01',
			currencyPairs: ['USD/CLP'],
		});

		expect(exchangeRatesService.syncExchangeRates).toHaveBeenCalledWith({
			startDate: '2026-06-01',
			endDate: '2026-06-01',
			currencyPairs: ['USD/PEN'],
		});
	});

	it('retorna únicamente registros persistidos desde Perú API', async () => {
		exchangeRatesService.getExchangeRates.mockResolvedValue([
			{ from_currency: 'USD', to_currency: 'PEN', source_type: 'PERU_API' },
			{ from_currency: 'USD', to_currency: 'PEN', source_type: 'BANCOCENTRAL' },
		]);

		const rates = await controller.getExchangeRatesHistory({ startDate: '2026-06-01', endDate: '2026-06-10' });

		expect(exchangeRatesService.getExchangeRates).toHaveBeenCalledWith({
			startDate: '2026-06-01',
			endDate: '2026-06-10',
			fromCurrency: 'USD',
			toCurrency: 'PEN',
		});
		expect(rates).toEqual([{ from_currency: 'USD', to_currency: 'PEN', source_type: 'PERU_API' }]);
	});
});

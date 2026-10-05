import axios from 'axios';

import { MONTHLY_AVG_BY_PAIR_SQL } from '../monthly-average';

import { ExchangeRatesService } from './exchange-rates.service';

jest.mock('axios');

describe('ExchangeRatesService', () => {
	const createService = () => {
		const exchangeRateRepository = {
			create: jest.fn((value) => value),
			findOne: jest.fn(),
			save: jest.fn(),
			update: jest.fn(),
		};
		const monthlyAvgRepository = {};
		const bancoCentralService = {
			getSeries: jest.fn(),
		};
		const bancoCentralSchemaService = {
			ensureSchema: jest.fn(),
		};
		const service = new ExchangeRatesService(
			exchangeRateRepository as any,
			monthlyAvgRepository as any,
			bancoCentralService as any,
			bancoCentralSchemaService as any
		);

		jest.spyOn(service as any, 'calculateIndirectConversions').mockResolvedValue({ inserted: 0, updated: 0 });
		jest.spyOn(service as any, 'calculateMonthlyAveragesForPeriod').mockResolvedValue({ periods: 0, currencyPairs: 0 });

		return { service, exchangeRateRepository, bancoCentralService, bancoCentralSchemaService };
	};

	const originalEnvironment = process.env;

	beforeEach(() => {
		jest.resetAllMocks();
		process.env = { ...originalEnvironment, PERU_API_KEY: 'peru-api-key' };
	});

	afterAll(() => {
		process.env = originalEnvironment;
	});

	it('persiste USD/PEN con la cotización de venta de Perú API', async () => {
		const { service, exchangeRateRepository, bancoCentralSchemaService } = createService();
		(axios.get as jest.Mock).mockResolvedValue({
			status: 200,
			data: {
				fecha: '2026-07-29',
				compra: '3.764',
				venta: '3.773',
				moneda: 'USD',
				fuente: 'SUNAT',
				mensaje: 'OK',
				code: '200',
			},
		});
		exchangeRateRepository.findOne.mockResolvedValue(null);

		const result = await service.syncExchangeRates({
			startDate: '2026-07-29',
			endDate: '2026-07-29',
			currencyPairs: ['USD/PEN'],
		});

		expect(bancoCentralSchemaService.ensureSchema).toHaveBeenCalled();
		expect(axios.get).toHaveBeenCalledWith('https://peruapi.com/api/tipo_cambio', {
			headers: { 'X-API-KEY': 'peru-api-key' },
			params: { fecha: '2026-07-29', summary: 0, plan: 0 },
			timeout: 8000,
		});
		expect(exchangeRateRepository.create).toHaveBeenCalledWith(
			expect.objectContaining({
				from_currency: 'USD',
				to_currency: 'PEN',
				rate: 3.773,
				source_type: 'PERU_API',
				api_source: 'Perú API (SUNAT)',
			})
		);
		expect(exchangeRateRepository.save).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			success: true,
			failedCurrencyPairs: [],
			stats: { totalProcessed: 1, inserted: 1, updated: 0, errors: 0 },
		});
	});

	it('omite Perú API cuando el scheduler la deshabilita', async () => {
		const { service } = createService();

		const result = await service.syncExchangeRates(
			{
				startDate: '2026-07-29',
				endDate: '2026-07-29',
				currencyPairs: ['USD/PEN'],
			},
			{ includePeruApi: false }
		);

		expect(axios.get).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			failedCurrencyPairs: [],
			stats: { totalProcessed: 0, errors: 0 },
		});
	});

	it('reporta USD/PEN como par fallido cuando falta la API key', async () => {
		const { service } = createService();
		delete process.env.PERU_API_KEY;

		const result = await service.syncExchangeRates({
			startDate: '2026-07-29',
			endDate: '2026-07-29',
			currencyPairs: ['USD/PEN'],
		});

		expect(axios.get).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			failedCurrencyPairs: ['USD/PEN'],
			stats: { totalProcessed: 0, errors: 1 },
		});
	});

	it('mantiene el flujo de Banco Central para los demás pares', async () => {
		const { service, exchangeRateRepository, bancoCentralService } = createService();
		bancoCentralService.getSeries.mockResolvedValue({
			Series: {
				Obs: [{ indexDateString: '29-07-2026', value: '920.50' }],
			},
		});
		exchangeRateRepository.findOne.mockResolvedValue(null);

		await service.syncExchangeRates({
			startDate: '2026-07-29',
			endDate: '2026-07-29',
			currencyPairs: ['USD/CLP'],
		});

		expect(bancoCentralService.getSeries).toHaveBeenCalledWith({
			timeseries: expect.any(String),
			firstdate: '2026-07-29',
			lastdate: '2026-07-29',
		});
		expect(axios.get).not.toHaveBeenCalled();
		expect(exchangeRateRepository.create).toHaveBeenCalledWith(
			expect.objectContaining({
				from_currency: 'USD',
				to_currency: 'CLP',
				source_type: 'BANCOCENTRAL',
			})
		);
	});

	it('reporta USD/PEN como fallido ante un error de Perú API', async () => {
		const { service } = createService();
		(axios.get as jest.Mock).mockRejectedValue(new Error('Request failed with status code 429'));

		const result = await service.syncExchangeRates({
			startDate: '2026-07-29',
			endDate: '2026-07-29',
			currencyPairs: ['USD/PEN'],
		});

		expect(result).toMatchObject({
			success: false,
			failedCurrencyPairs: ['USD/PEN'],
			stats: { errors: 1 },
		});
	});

	it('limita los rangos de USD/PEN para respetar el rate limit del plan Free', async () => {
		const { service } = createService();

		const result = await service.syncExchangeRates({
			startDate: '2026-07-01',
			endDate: '2026-07-11',
			currencyPairs: ['USD/PEN'],
		});

		expect(axios.get).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			failedCurrencyPairs: ['USD/PEN'],
			stats: { errors: 1 },
		});
	});

	it('calculateMonthlyAverages: regla compartida (todas las fuentes diarias, días hábiles), upsert con calculated_at = now() y onlyPairs', async () => {
		const exchangeRateRepository = {
			query: jest.fn().mockResolvedValue([
				{
					from_currency: 'USD',
					to_currency: 'CLP',
					year: 2026,
					month: 9,
					avg_rate: '950',
					min_rate: '940',
					max_rate: '960',
					data_points: 21,
				},
				{
					from_currency: 'EUR',
					to_currency: 'USD',
					year: 2026,
					month: 9,
					avg_rate: '1.17',
					min_rate: '1.1',
					max_rate: '1.2',
					data_points: 21,
				},
			]),
		};
		const monthlyAvgRepository = { query: jest.fn().mockResolvedValue([{ inserted: false }]) };
		const service = new ExchangeRatesService(
			exchangeRateRepository as any,
			monthlyAvgRepository as any,
			{} as any,
			{ ensureSchema: jest.fn() } as any
		);

		const result = await service.calculateMonthlyAverages({ year: 2026, month: 9 }, [{ from_currency: 'USD', to_currency: 'CLP' }]);

		expect(exchangeRateRepository.query).toHaveBeenCalledWith(MONTHLY_AVG_BY_PAIR_SQL, ['2026-09-01', '2026-10-01']);
		expect(result.stats).toEqual({ periodsProcessed: 1, currencyPairsProcessed: 1, recordsCreated: 0, recordsUpdated: 1 });
		expect(monthlyAvgRepository.query).toHaveBeenCalledTimes(1);
		const [sql, params] = monthlyAvgRepository.query.mock.calls[0];

		expect(sql).toContain('ON CONFLICT (from_currency, to_currency, year, month) DO UPDATE');
		expect(sql).toContain('calculated_at = EXCLUDED.calculated_at');
		expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())');
		expect(params).toEqual(['USD', 'CLP', 2026, 9, '950', '940', '960', 21]);
	});
});

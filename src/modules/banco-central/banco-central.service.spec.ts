import { BancoCentralService } from './banco-central.service';
import { IndicadorEconomico } from './interfaces/banco-central.interface';

describe('BancoCentralService', () => {
	it('no sincroniza USD/PEN como indicador del Banco Central', async () => {
		const indicadorRepository = {};
		const configService = {
			get: jest.fn((key: string) => {
				if (key === 'BANCO_CENTRAL_USER') return 'user';
				if (key === 'BANCO_CENTRAL_PASS') return 'pass';
				return undefined;
			}),
		};
		const bancoCentralSchemaService = {
			ensureSchema: jest.fn(),
		};
		const service = new BancoCentralService(indicadorRepository as any, configService as any, bancoCentralSchemaService as any);
		const getSeries = jest.spyOn(service, 'getSeries').mockResolvedValue({ Series: { Obs: [] } } as any);
		jest.spyOn(service as any, 'saveIndicatorData').mockResolvedValue(0);

		await service.syncIndicators({ firstdate: '2026-07-01', lastdate: '2026-07-01' });

		const syncedCodes = getSeries.mock.calls.map(([dto]) => dto.timeseries);
		expect(syncedCodes).not.toContain(IndicadorEconomico.DOLAR_SOL_PERUANO);
		expect(bancoCentralSchemaService.ensureSchema).toHaveBeenCalled();
	});
});

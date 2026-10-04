import { FxMonthCloseScheduler } from './fx-month-close.scheduler';

describe('FxMonthCloseScheduler', () => {
	const result = {
		month: '2026-09-01',
		closed_averages: ['2026-09 USD/CLP'],
		incomplete_averages: [],
		holdings: [{ holding_id: 'h1', success: true, contracts: 3, failed_contracts: 0, pending_rows: 0, pending_pairs: [] }],
	};
	const create = (enabled?: string) => {
		const service = { run: jest.fn().mockResolvedValue(result) };
		const config = { get: jest.fn((key: string) => (key === 'FX_MONTH_CLOSE_ENABLED' ? enabled : undefined)) };

		return { scheduler: new FxMonthCloseScheduler(service as any, config as any), service };
	};

	it('corre el cierre (días 1 a 5, 10:00 Santiago) y devuelve el resultado', async () => {
		const { scheduler, service } = create();

		await expect(scheduler.closeMonth()).resolves.toEqual(result);
		expect(service.run).toHaveBeenCalledWith();
	});

	it('FX_MONTH_CLOSE_ENABLED=false lo apaga', async () => {
		const { scheduler, service } = create('false');

		await expect(scheduler.closeMonth()).resolves.toBeNull();
		expect(service.run).not.toHaveBeenCalled();
	});

	it('no corre dos veces a la vez en la misma réplica y un error crítico no lanza', async () => {
		const { scheduler, service } = create();
		let release!: () => void;

		service.run.mockReturnValueOnce(new Promise((resolve) => (release = () => resolve(result))));
		const first = scheduler.closeMonth();

		await expect(scheduler.closeMonth()).resolves.toBeNull();
		release();
		await first;
		service.run.mockRejectedValueOnce(new Error('caído'));
		await expect(scheduler.closeMonth()).resolves.toBeNull();
	});

	it('el cron es el del día 1 (con reintentos hasta el 5) después de la sincronización diaria de tasas', () => {
		const metadata = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', FxMonthCloseScheduler.prototype.closeMonth);

		expect(metadata).toMatchObject({ cronTime: '0 10 1-5 * *', name: 'fx-month-close', timeZone: 'America/Santiago' });
	});
});

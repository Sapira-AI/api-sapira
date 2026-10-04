import { BadRequestException } from '@nestjs/common';

import { API_WRITER_SQL } from '@/modules/contracts/api-writer';

import { MONTHLY_AVG_DAILY_RATES_SQL } from '../monthly-average';

import { FX_SYNC_FAILURE_NOTIFICATION_TYPE } from './exchange-rates-notification.service';
import { FxMonthCloseService, monthLabelEs, NEEDS_FX_CLOSE_SQL } from './fx-month-close.service';

type Handler = (sql: string, params?: unknown[]) => unknown;

/** DataSource falso: `query` responde según la consulta; cada transacción `withApiWriter` usa un runner que registra sus sentencias. */
const fakeDataSource = (handler: Handler) => {
	const runnerSql: string[][] = [];
	const dataSource = {
		query: jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
		createQueryRunner: jest.fn(() => {
			const statements: string[] = [];

			runnerSql.push(statements);

			return {
				connect: jest.fn(),
				startTransaction: jest.fn(),
				commitTransaction: jest.fn(),
				rollbackTransaction: jest.fn(),
				release: jest.fn(),
				query: jest.fn(async (sql: string, params?: unknown[]) => {
					statements.push(sql);
					const failing = params?.[0] === 'contrato-malo' && sql.includes('revenue_schedule_apply_fx_for_contract');

					if (failing) throw new Error('boom');

					return [];
				}),
			};
		}),
	};

	return { dataSource, runnerSql };
};

const setup = (handler: Handler) => {
	const { dataSource, runnerSql } = fakeDataSource(handler);
	const exchangeRates = { calculateMonthlyAverages: jest.fn().mockResolvedValue({ success: true }) };
	const notifications = { createOrUpdate: jest.fn().mockResolvedValue({ notification: {} }), resolveByDeduplicationKey: jest.fn() };
	const service = new FxMonthCloseService(dataSource as any, exchangeRates as any, notifications as any);

	return { service, dataSource, runnerSql, exchangeRates, notifications };
};

/** Respuestas típicas: backlog vacío, cobertura del mes, 1 holding con 2 contratos y nada pendiente. */
const defaultHandler =
	(overrides: Partial<Record<'backlog' | 'coverage' | 'holdings' | 'contracts' | 'pending', unknown[]>> = {}): Handler =>
	(sql) => {
		if (sql.includes('FROM exchange_rates_monthly_avg ma') && sql.includes('SELECT DISTINCT make_date')) return overrides.backlog ?? [];
		if (sql.includes('FROM exchange_rates er')) {
			return (
				overrides.coverage ?? [
					{ from_currency: 'USD', to_currency: 'CLP', days: 22, last_date: '2026-09-30' },
					{ from_currency: 'USD', to_currency: 'UYU', days: 10, last_date: '2026-09-15' },
				]
			);
		}
		if (sql.includes('SELECT DISTINCT holding_id')) return overrides.holdings ?? [{ holding_id: 'h1' }];
		if (sql.includes('MIN(r.period_month)')) return overrides.contracts ?? [{ id: 'c1', from_month: '2026-09-01' }];
		if (sql.includes('AS pair')) return overrides.pending ?? [];

		return [];
	};

describe('FxMonthCloseService (cierre mensual de la moneda de compañía)', () => {
	const asOf = new Date('2026-10-01T13:00:00Z'); // 01-10 10:00 Santiago

	it('cierra solo los pares completos del mes terminado, recalcula los contratos y cierra el aviso si no queda nada', async () => {
		const { service, exchangeRates, runnerSql, notifications } = setup(defaultHandler());

		const result = await service.run({ asOf });

		expect(result.month).toBe('2026-09-01');
		expect(exchangeRates.calculateMonthlyAverages).toHaveBeenCalledTimes(1);
		expect(exchangeRates.calculateMonthlyAverages).toHaveBeenCalledWith({ year: 2026, month: 9 }, [{ from_currency: 'USD', to_currency: 'CLP' }]);
		expect(result.closed_averages).toEqual(['2026-09 USD/CLP']);
		expect(result.incomplete_averages).toEqual(['2026-09 USD/UYU: 10 de 22 días hábiles']);
		// Una transacción v2 por contrato: marca de escritor primero, contrato bloqueado y apply_fx desde su primer mes pendiente.
		expect(runnerSql).toHaveLength(1);
		expect(runnerSql[0][0]).toBe(API_WRITER_SQL);
		expect(runnerSql[0][1]).toContain('FOR UPDATE');
		expect(runnerSql[0][2]).toContain('revenue_schedule_apply_fx_for_contract($1::uuid, $2::date)');
		expect(result.holdings).toEqual([{ holding_id: 'h1', success: true, contracts: 1, failed_contracts: 0, pending_rows: 0, pending_pairs: [] }]);
		expect(notifications.resolveByDeduplicationKey).toHaveBeenCalledWith('h1', 'fx-month-close:2026-09');
		expect(notifications.createOrUpdate).not.toHaveBeenCalled();
	});

	it('force cierra también los pares incompletos del mes pedido (no los del backlog)', async () => {
		const { service, exchangeRates } = setup(defaultHandler({ backlog: [{ month: '2026-07-01' }] }));

		const result = await service.run({ asOf, month: '2026-09', force: true });

		expect(exchangeRates.calculateMonthlyAverages).toHaveBeenCalledWith({ year: 2026, month: 9 }, [
			{ from_currency: 'USD', to_currency: 'CLP' },
			{ from_currency: 'USD', to_currency: 'UYU' },
		]);
		// Backlog de julio: solo el par completo.
		expect(exchangeRates.calculateMonthlyAverages).toHaveBeenCalledWith({ year: 2026, month: 7 }, [{ from_currency: 'USD', to_currency: 'CLP' }]);
		expect(result.closed_averages).toContain('2026-09 USD/UYU');
		expect(result.closed_averages).not.toContain('2026-07 USD/UYU');
	});

	it('si quedan filas del mes sin moneda de compañía, alerta por holding (fx_sync_failure, clave del mes) y no lanza', async () => {
		const { service, notifications } = setup(defaultHandler({ pending: [{ pair: 'USD → UYU', rows: 60 }] }));

		const result = await service.run({ asOf });

		expect(result.holdings[0]).toMatchObject({ pending_rows: 60, pending_pairs: ['USD → UYU'] });
		expect(notifications.createOrUpdate).toHaveBeenCalledWith(
			'h1',
			expect.objectContaining({
				type: FX_SYNC_FAILURE_NOTIFICATION_TYPE,
				severity: 'warning',
				title: 'Falta el tipo de cambio promedio de septiembre de 2026',
				deduplication_key: 'fx-month-close:2026-09',
				metadata: { month: '2026-09', pairs: ['USD → UYU'], rows: 60 },
			})
		);
		expect(notifications.resolveByDeduplicationKey).not.toHaveBeenCalled();
	});

	it('un contrato que falla no detiene a los demás; un holding que falla queda con su error', async () => {
		const handler = defaultHandler({
			holdings: [{ holding_id: 'h1' }, { holding_id: 'h2' }],
			contracts: [
				{ id: 'contrato-malo', from_month: '2026-09-01' },
				{ id: 'c2', from_month: '2026-10-01' },
			],
		});
		const { service } = setup((sql, params) => {
			if (sql.includes('MIN(r.period_month)') && params?.[0] === 'h2') throw new Error('sin conexión');

			return handler(sql, params);
		});

		const result = await service.run({ asOf });

		expect(result.holdings[0]).toMatchObject({ holding_id: 'h1', success: false, contracts: 1, failed_contracts: 1 });
		expect(result.holdings[1]).toMatchObject({ holding_id: 'h2', success: false, error: 'sin conexión' });
	});

	it('nunca toca meses cerrados ni lee el mes en curso de la sesión: primer mes abierto por compañía y "hoy" del holding', async () => {
		const { service, dataSource } = setup(defaultHandler());

		await service.run({ asOf });
		const [sql, params] = (dataSource.query.mock.calls as Array<[string, unknown[]]>).find(([text]) => text.includes('MIN(r.period_month)'))!;

		expect(sql).toContain(
			`r.period_month >= COALESCE((date_trunc('month', public.get_cutoff_date(c.holding_id, c.company_id)) + interval '1 month')::date`
		);
		expect(sql).toContain(`DATE_TRUNC('month', $2::timestamptz AT TIME ZONE COALESCE(NULLIF(TRIM(hs.timezone), ''), 'America/Santiago'))`);
		expect(sql).not.toContain('now()');
		expect(params).toEqual(['h1', asOf.toISOString()]);
	});

	it('qué filas se recalculan: meses terminados pendientes, en curso/futuros con la regla anterior y sistema proyectado', () => {
		expect(NEEDS_FX_CLOSE_SQL).toContain(`r.period_month < cur.month AND r.fx_to_company_source IN ('pending_month_close', 'missing_fx_rate')`);
		expect(NEEDS_FX_CLOSE_SQL).toContain(`r.period_month >= cur.month AND r.fx_to_company_source LIKE 'monthly_average%'`);
		expect(NEEDS_FX_CLOSE_SQL).toContain(`r.fx_to_system_source LIKE '%\\_projected'`);
	});

	it('rechaza un mes que no ha terminado o mal escrito', async () => {
		const { service } = setup(defaultHandler());

		await expect(service.run({ asOf, month: '2026-10' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.run({ asOf, month: 'octubre' })).rejects.toBeInstanceOf(BadRequestException);
	});

	it('monthLabelEs', () => {
		expect(monthLabelEs('2026-09-01')).toBe('septiembre de 2026');
	});

	it('la cobertura cuenta las mismas tasas diarias que el promedio (todas las fuentes diarias, días hábiles) y excluye los ya cerrados', async () => {
		const { service, dataSource } = setup(defaultHandler());

		await service.coverage('2026-07-01');
		const [sql, params] = dataSource.query.mock.calls[0];

		expect(sql).toContain(MONTHLY_AVG_DAILY_RATES_SQL);
		expect(sql).not.toContain(`'PERU_API' ELSE 'BANCOCENTRAL' END`);
		expect(sql).toContain('ma.data_points > 1 AND ma.calculated_at >= ($2::date::timestamp AT TIME ZONE $3)');
		expect(params).toEqual(['2026-07-01', '2026-08-01', 'America/Santiago']);
	});
});

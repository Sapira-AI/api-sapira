import { DataSource } from 'typeorm';

import { loadMetricsHistoryStart, monthOfDate } from '@/core/utils/holding-preferences';
import { ClientMetricsService } from '@/modules/clients/client-metrics.service';

import { HoldingMetricsService } from './holding-metrics.service';
import { KEY_LABELS } from './metrics-categories';
import { MetricsDataService } from './metrics-data.service';
import {
	legacyAfterContractSql,
	legacyCountedConditions,
	legacyRemovedSql,
	legacySeamMonthSql,
	legacySkipCodeSql,
	skipReasonCodeOf,
} from './mrr-historico';
import { MrrMetricsService } from './mrr-metrics.service';

import type { MrrLine } from './mrr-movements';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const sqlOf = (query: jest.Mock, needle: string) => query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes(needle));

describe('MRR histórico: una sola regla de qué filas cuentan (onboarding §3.1, U14)', () => {
	it('motivo: solo la columna normalizada; sin código es "No activado" (churn) aunque el texto diga duplicado (Domi 18-10)', () => {
		expect(skipReasonCodeOf({ skip_activation: false, skip_activation_reason: 'duplicado' })).toBeNull();
		expect(skipReasonCodeOf({ skip_activation: true, skip_activation_reason: 'DUPLICADO, YA SE ENCUENTRA SUSCRIPCIÓN' })).toBe('churn');
		expect(skipReasonCodeOf({ skip_activation: true, skip_activation_reason: 'Error de importación' })).toBe('churn');
		expect(skipReasonCodeOf({ skip_activation: true, skip_activation_reason: 'Churn Abril 2026' })).toBe('churn');
		expect(skipReasonCodeOf({ skip_activation: true, skip_activation_reason: null })).toBe('churn');
		expect(skipReasonCodeOf({ skip_activation: true, skip_reason_code: 'error', skip_activation_reason: 'Churn' })).toBe('error');
		expect(skipReasonCodeOf({ skip_activation: true, skip_reason_code: 'duplicate' })).toBe('duplicate');
		expect(skipReasonCodeOf({ skip_activation: true, skip_reason_code: 'otro' })).toBe('churn');
	});

	it('el SQL lee la columna tolerante (to_jsonb), no interpreta el texto libre y aplica recurrente + corte U14 + no quitada', () => {
		expect(legacySkipCodeSql()).toBe("(CASE WHEN m.skip_activation THEN COALESCE(to_jsonb(m) ->> 'skip_reason_code', 'churn') END)");
		expect(legacySkipCodeSql()).not.toContain('skip_activation_reason');
		expect(legacySkipCodeSql()).not.toContain('ILIKE');
		expect(legacyRemovedSql()).toContain("IN ('duplicate', 'error')");
		expect(legacyCountedConditions()).toEqual([
			'COALESCE(m.is_recurring, false) = true',
			'NOT (f.first_month IS NOT NULL AND m.period_month >= f.first_month)',
			`NOT ${legacyRemovedSql()}`,
		]);
	});

	it('el corte U14 se reporta en dos casos: mes de empalme (=) y histórico después del inicio del contrato (>)', () => {
		expect(legacySeamMonthSql()).toBe('(f.first_month IS NOT NULL AND m.period_month = f.first_month)');
		expect(legacyAfterContractSql()).toBe('(f.first_month IS NOT NULL AND m.period_month > f.first_month)');
	});

	it('Métricas, Dashboard/Clientes y Cliente 360 usan la misma regla (sin duplicarla)', async () => {
		const query = jest.fn(async (sql: string): Promise<unknown[]> => (sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : []));
		const data = new MetricsDataService({ query } as unknown as DataSource);

		await data.loadMrrLines(HOLDING, {}, { mode: 'system', code: 'USD' }, 'mrr', '2026-01', '2026-03');
		await new HoldingMetricsService({ query } as unknown as DataSource).monthMetrics(HOLDING, '2026-03-10');
		const clients = new ClientMetricsService({ query } as unknown as DataSource, new HoldingMetricsService({ query } as unknown as DataSource));

		query.mockImplementation(async (sql: string) => (sql.includes('FROM clients WHERE id') ? [{ ok: 1 }] : []));
		await clients.getSummary('c-1', HOLDING, new Date('2026-03-10T12:00:00Z'));
		const legacy = sqlOf(query, 'FROM mrr_legacy m');

		expect(legacy.length).toBe(3);
		for (const sql of legacy) {
			for (const condition of legacyCountedConditions()) expect(sql).toContain(condition);
			expect(sql).toContain('first_rsm AS (');
		}
	});
});

describe('Inicio de la historia en Métricas (holding_settings.metrics_history_start)', () => {
	it('lectura tolerante: columna ausente o sin fila → null; fecha → YYYY-MM', async () => {
		expect(monthOfDate('2025-01-01')).toBe('2025-01');
		expect(monthOfDate(null)).toBeNull();
		expect(monthOfDate('basura')).toBeNull();
		await expect(loadMetricsHistoryStart({ query: async () => [] }, HOLDING)).resolves.toBeNull();
		await expect(loadMetricsHistoryStart({ query: async () => [{ start: null }] }, HOLDING)).resolves.toBeNull();
		await expect(loadMetricsHistoryStart({ query: async () => [{ start: '2025-01-01' }] }, HOLDING)).resolves.toBe('2025-01');
	});

	const historyFrom = async (start: string | null, first: string) => {
		const query = jest.fn(async (sql: string) => {
			if (sql.includes("'metrics_history_start'")) return [{ start }];
			if (sql.includes('holding_settings')) return [{ system_currency: 'USD' }];
			if (sql.includes('AS first')) return [{ first }];

			return [];
		});
		const data = new MetricsDataService({ query } as unknown as DataSource);
		const load = jest.spyOn(data, 'loadMrrLines').mockResolvedValue({ lines: [] as MrrLine[], itemFxMissing: new Set<string>() });

		await new MrrMetricsService(data).cohorts(HOLDING, { from: '2026-01', to: '2026-03' });

		return load.mock.calls[0][4];
	};

	it('manda el mayor entre el primer dato y el inicio fijado; sin inicio, el primer dato', async () => {
		await expect(historyFrom('2025-01-01', '2024-01')).resolves.toBe('2025-01');
		await expect(historyFrom(null, '2024-01')).resolves.toBe('2024-01');
		await expect(historyFrom('2023-06-01', '2024-01')).resolves.toBe('2024-01');
	});
});

describe('Etiquetas visibles: "MRR histórico" (no "Legacy")', () => {
	it('subcategorías del waterfall', () => {
		expect(KEY_LABELS.LEGACY_NEW).toBe('MRR histórico nuevo');
		expect(KEY_LABELS.LEGACY_END).toBe('MRR histórico terminado');
		expect(KEY_LABELS.LEGACY_CHANGE).toBe('Variación MRR histórico');
		expect(KEY_LABELS.LEGACY_MIGRATION).toBe('MRR histórico → contrato');
		expect(Object.values(KEY_LABELS).some((label) => /legacy/i.test(label))).toBe(false);
	});

	it('origen por dimensión y motivo de churn sin contrato', async () => {
		const query = jest.fn(async (sql: string) => (sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : []));
		const data = new MetricsDataService({ query } as unknown as DataSource);
		const line: MrrLine = {
			key: 'l:1',
			source: 'legacy',
			contractId: null,
			contractNumber: null,
			itemId: null,
			clientId: 'cl-1',
			clientName: 'ACME',
			companyId: null,
			companyName: null,
			product: 'P',
			categoria: null,
			renewsItemId: null,
			renewedByItemId: null,
			legacyContractId: null,
			segment: null,
			market: null,
			industry: null,
			country: null,
			itemType: null,
			unitOfMeasure: null,
			months: new Map([
				['2026-01', { value: 100, valueContract: 100, pending: 0, momentum: null }],
				['2026-02', { value: 0, valueContract: 0, pending: 0, momentum: null }],
			]),
		};

		jest.spyOn(data, 'loadMrrLines').mockResolvedValue({ lines: [line], itemFxMissing: new Set<string>() });
		const mrr = new MrrMetricsService(data);
		const bySource = await mrr.byDimension(HOLDING, { from: '2026-01', to: '2026-01', dimension: 'source' });
		const churn = await mrr.churn(HOLDING, { from: '2026-02', to: '2026-02' });

		expect(bySource.rows[0].label).toBe('MRR histórico');
		expect(JSON.stringify(churn)).toContain('MRR histórico sin contrato');
		expect(JSON.stringify(churn)).not.toContain('Legacy sin contrato');
	});
});

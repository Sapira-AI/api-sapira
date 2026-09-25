import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

type Row = Record<string, unknown>;

export interface MonthMetric {
	value: number;
	previous: number;
	/** Variación % contra el mes anterior (0 si no hubo mes anterior). */
	trend: number;
}

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const trendOf = (current: number, previous: number) => (previous > 0 ? ((current - previous) / previous) * 100 : 0);

/**
 * Métricas del holding con UNA sola definición (decisión Domi 24-09-2026), para Dashboard y Clientes:
 * - **MRR del mes** = MRR del devengo (`revenue_schedule_monthly`, contratos y suscripciones) + MRR legacy del mes,
 *   en moneda del sistema.
 * - **Clientes activos** = clientes con MRR > 0 en el mes (misma fuente que el MRR, así siempre cuadran). Es distinto
 *   del estado calculado del cliente (`client-lifecycle.ts`), que mide si tiene contrato o suscripción vigente.
 * - **Moneda** = `holding_settings.system_currency` (USD si el holding no tiene configuración).
 *
 * ⚠️ El MRR legacy del mes se suma aunque el cliente ya tenga contrato (doble conteo, U14 de
 * `docs/v2-rediseno/auditoria-contratos.md`): al corregirse aquí, se corrige en ambas vistas.
 */
@Injectable()
export class HoldingMetricsService {
	constructor(private readonly dataSource: DataSource) {}

	async systemCurrency(holdingId: string): Promise<string> {
		const [row] = await this.dataSource.query<Row[]>(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [holdingId]);

		return (row?.system_currency as string) || 'USD';
	}

	/** MRR por cliente en el mes de `asOf` y el anterior (base de las dos métricas). */
	private mrrByClientSql = `
		WITH months AS (SELECT date_trunc('month', $2::date) AS cur, date_trunc('month', $2::date) - interval '1 month' AS prev),
		mrr AS (
			SELECT COALESCE(c.client_id, s.client_id) AS client_id, r.period_month, r.mrr_period_system_ccy AS value
			FROM revenue_schedule_monthly r
			LEFT JOIN contracts c ON c.id = r.contract_id
			LEFT JOIN subscriptions s ON s.id = r.subscription_id
			WHERE r.holding_id = $1 AND r.is_total_row = false AND r.period_month IN ((SELECT cur FROM months), (SELECT prev FROM months))
			UNION ALL
			SELECT m.client_id, m.period_month, m.mrr_legacy_system_currency
			FROM mrr_legacy m
			WHERE m.holding_id = $1 AND m.period_month IN ((SELECT cur FROM months), (SELECT prev FROM months))
		),
		by_client AS (
			SELECT client_id,
				SUM(value) FILTER (WHERE period_month = (SELECT cur FROM months)) AS cur,
				SUM(value) FILTER (WHERE period_month = (SELECT prev FROM months)) AS prev
			FROM mrr GROUP BY client_id
		)`;

	async monthMetrics(holdingId: string, asOf: string): Promise<{ currency: string; mrr: MonthMetric; activeClients: MonthMetric }> {
		const [[row], currency] = await Promise.all([
			this.dataSource.query<Row[]>(
				`${this.mrrByClientSql}
				SELECT COALESCE(SUM(cur), 0) AS mrr_cur, COALESCE(SUM(prev), 0) AS mrr_prev,
					COUNT(*) FILTER (WHERE cur > 0 AND client_id IS NOT NULL) AS clients_cur,
					COUNT(*) FILTER (WHERE prev > 0 AND client_id IS NOT NULL) AS clients_prev
				FROM by_client`,
				[holdingId, asOf]
			),
			this.systemCurrency(holdingId),
		]);
		const mrr = toNumber(row?.mrr_cur);
		const mrrPrev = toNumber(row?.mrr_prev);
		const clients = toNumber(row?.clients_cur);
		const clientsPrev = toNumber(row?.clients_prev);

		return {
			currency,
			mrr: { value: mrr, previous: mrrPrev, trend: trendOf(mrr, mrrPrev) },
			activeClients: { value: clients, previous: clientsPrev, trend: trendOf(clients, clientsPrev) },
		};
	}
}

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

type NumericRow = Record<string, string | number | null>;

@Injectable()
export class DashboardService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly holdingMetrics: HoldingMetricsService
	) {}

	/** KPIs y tareas del holding activo (validado por `HoldingScopeGuard`). */
	async getHome(holdingId: string, asOf = new Date()): Promise<Record<string, unknown>> {
		const date = asOf.toISOString().slice(0, 10);

		// MRR y clientes activos: una sola definición compartida con Clientes (HoldingMetricsService).
		const [metrics, recognizedRevenue, invoices, tasks] = await Promise.all([
			this.holdingMetrics.monthMetrics(holdingId, date),
			this.getRecognizedRevenue(holdingId, date),
			this.getInvoiceSummary(holdingId, date),
			this.getTasks(holdingId, date),
		]);
		const mrr = { value: metrics.mrr.value, trend: metrics.mrr.trend, currency: metrics.currency };
		const activeClients = { value: metrics.activeClients.value, trend: metrics.activeClients.trend };
		// Todos los montos están en moneda del sistema: la del holding, no USD fijo.
		recognizedRevenue.currency = metrics.currency;
		invoices.toIssue.currency = metrics.currency;

		return {
			holding_id: holdingId,
			as_of: date,
			kpis: {
				mrr,
				active_clients: activeClients,
				recognized_revenue: recognizedRevenue,
				pending_invoices: invoices.toIssue,
			},
			tasks: {
				overdue_invoices: invoices.overdue.count,
				expired_contracts: tasks.expiredContracts,
				contracts_to_renew_30: tasks.renew30,
				contracts_to_renew_90: tasks.renew90,
				invoices_to_emit: invoices.toIssue.count,
				items_starting_this_month: tasks.startsThisMonth,
			},
		};
	}

	private async getRecognizedRevenue(holdingId: string, asOf: string) {
		const rows = await this.dataSource.query<NumericRow[]>(
			`SELECT COALESCE(SUM(recognized_period_system_ccy), 0) AS value
			 FROM revenue_schedule_monthly
			 WHERE holding_id = $1 AND is_total_row = false
			 AND period_month >= date_trunc('month', $2::date) - interval '11 months'
			 AND period_month <= date_trunc('month', $2::date)`,
			[holdingId, asOf]
		);
		return { value: Number(rows[0]?.value || 0), period: 'Últimos 12 meses', trend: 0, currency: 'USD' };
	}

	private async getInvoiceSummary(holdingId: string, asOf: string) {
		const rows = await this.dataSource.query<NumericRow[]>(
			`SELECT
				COUNT(*) FILTER (WHERE status = 'Por Emitir' AND COALESCE(scheduled_at, issue_date) <= $2::date) AS to_issue_count,
				COALESCE(SUM(amount_system_currency) FILTER (WHERE status = 'Por Emitir' AND COALESCE(scheduled_at, issue_date) <= $2::date), 0) AS to_issue_amount,
				COUNT(*) FILTER (WHERE due_date < $2::date AND status <> 'Pagada') AS overdue_count
			 FROM invoices
			 WHERE holding_id = $1 AND is_active = true`,
			[holdingId, asOf]
		);
		const row = rows[0] || {};
		return {
			toIssue: { count: Number(row.to_issue_count || 0), amount: Number(row.to_issue_amount || 0), currency: 'USD' },
			overdue: { count: Number(row.overdue_count || 0) },
		};
	}

	private async getTasks(holdingId: string, asOf: string) {
		const rows = await this.dataSource.query<NumericRow[]>(
			`SELECT
				COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Activo' AND c.contract_end_date >= $2::date AND c.contract_end_date <= $2::date + interval '30 days') AS renew_30,
				COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Activo' AND c.contract_end_date >= $2::date AND c.contract_end_date <= $2::date + interval '90 days') AS renew_90,
				COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'Activo' AND EXISTS (
					SELECT 1 FROM contract_items ci
					WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					GROUP BY ci.contract_id HAVING MAX(ci.end_date) < $2::date
				)) AS expired_contracts,
				COUNT(DISTINCT ci.id) FILTER (WHERE ci.categoria IN ('NEW', 'UPSELL', 'CROSS-SELL')
					AND ci.start_date >= date_trunc('month', $2::date)
					AND ci.start_date < date_trunc('month', $2::date) + interval '1 month'
					AND ci.churn_date IS NULL) AS starts_this_month
			 FROM contracts c
			 LEFT JOIN contract_items ci ON ci.contract_id = c.id
			 WHERE c.holding_id = $1`,
			[holdingId, asOf]
		);
		const row = rows[0] || {};
		return {
			expiredContracts: Number(row.expired_contracts || 0),
			renew30: Number(row.renew_30 || 0),
			renew90: Number(row.renew_90 || 0),
			startsThisMonth: Number(row.starts_this_month || 0),
		};
	}
}

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

type NumericRow = Record<string, string | number | null>;

@Injectable()
export class DashboardService {
	constructor(private readonly dataSource: DataSource) {}

	async getHome(authId: string, asOf = new Date()): Promise<Record<string, unknown>> {
		const holdingId = await this.getSelectedHoldingId(authId);
		const date = asOf.toISOString().slice(0, 10);

		if (!holdingId) {
			return this.emptyHome(date);
		}

		const [mrr, activeClients, recognizedRevenue, invoices, tasks] = await Promise.all([
			this.getMrr(holdingId, date),
			this.getActiveClients(holdingId, date),
			this.getRecognizedRevenue(holdingId, date),
			this.getInvoiceSummary(holdingId, date),
			this.getTasks(holdingId, date),
		]);

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

	private async getSelectedHoldingId(authId: string): Promise<string | null> {
		const [row] = await this.dataSource.query<{ holding_id: string }[]>(
			`SELECT uh.holding_id
			 FROM user_holdings uh
			 JOIN users u ON u.id = uh.user_id
			 WHERE u.auth_id = $1 AND uh.selected = true AND uh.is_active = true
			 LIMIT 1`,
			[authId]
		);
		return row?.holding_id || null;
	}

	private async getMrr(holdingId: string, asOf: string) {
		const rows = await this.dataSource.query<NumericRow[]>(
			`WITH monthly_mrr AS (
				SELECT period_month, mrr_period_system_ccy AS value
				FROM revenue_schedule_monthly
				WHERE holding_id = $1 AND is_total_row = false
				AND period_month IN (date_trunc('month', $2::date), date_trunc('month', $2::date) - interval '1 month')
				UNION ALL
				SELECT period_month, mrr_legacy_system_currency AS value
				FROM mrr_legacy
				WHERE holding_id = $1
				AND period_month IN (date_trunc('month', $2::date), date_trunc('month', $2::date) - interval '1 month')
			)
			SELECT
				COALESCE(SUM(value) FILTER (WHERE period_month = date_trunc('month', $2::date)), 0) AS current,
				COALESCE(SUM(value) FILTER (WHERE period_month = date_trunc('month', $2::date) - interval '1 month'), 0) AS previous
			FROM monthly_mrr`,
			[holdingId, asOf]
		);
		const row = rows[0] || {};
		const current = Number(row.current || 0);
		const previous = Number(row.previous || 0);
		return { value: current, trend: previous > 0 ? ((current - previous) / previous) * 100 : 0, currency: 'USD' };
	}

	private async getActiveClients(holdingId: string, asOf: string) {
		const rows = await this.dataSource.query<NumericRow[]>(
			`SELECT
				COUNT(DISTINCT client_id) FILTER (WHERE month = date_trunc('month', $2::date)) AS current,
				COUNT(DISTINCT client_id) FILTER (WHERE month = date_trunc('month', $2::date) - interval '1 month') AS previous
			 FROM (
				SELECT c.client_id, date_trunc('month', r.period_month) AS month
				FROM revenue_schedule_monthly r
				JOIN contracts c ON c.id = r.contract_id
				WHERE r.holding_id = $1 AND r.is_total_row = false
				AND r.period_month IN (date_trunc('month', $2::date), date_trunc('month', $2::date) - interval '1 month')
				UNION
				SELECT s.client_id, date_trunc('month', r.period_month) AS month
				FROM revenue_schedule_monthly r
				JOIN subscriptions s ON s.id = r.subscription_id
				WHERE r.holding_id = $1
				AND r.period_month IN (date_trunc('month', $2::date), date_trunc('month', $2::date) - interval '1 month')
				UNION
				SELECT client_id, date_trunc('month', period_month) AS month
				FROM mrr_legacy
				WHERE holding_id = $1
				AND period_month IN (date_trunc('month', $2::date), date_trunc('month', $2::date) - interval '1 month')
			 ) active_clients`,
			[holdingId, asOf]
		);
		const row = rows[0] || {};
		const current = Number(row.current || 0);
		const previous = Number(row.previous || 0);
		return { value: current, trend: previous > 0 ? ((current - previous) / previous) * 100 : 0 };
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

	private emptyHome(asOf: string) {
		return {
			holding_id: null,
			as_of: asOf,
			kpis: {
				mrr: { value: 0, trend: 0, currency: 'USD' },
				active_clients: { value: 0, trend: 0 },
				recognized_revenue: { value: 0, period: 'Últimos 12 meses', trend: 0, currency: 'USD' },
				pending_invoices: { count: 0, amount: 0, currency: 'USD' },
			},
			tasks: {
				overdue_invoices: 0,
				expired_contracts: 0,
				contracts_to_renew_30: 0,
				contracts_to_renew_90: 0,
				invoices_to_emit: 0,
				items_starting_this_month: 0,
			},
		};
	}
}

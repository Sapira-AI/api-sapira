import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadFxProjected } from '@/modules/metrics/fx-projected';
import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';
import { TasksService } from '@/modules/tasks/tasks.service';

type NumericRow = Record<string, string | number | null>;

@Injectable()
export class DashboardService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly holdingMetrics: HoldingMetricsService,
		private readonly tasksService: TasksService
	) {}

	/** KPIs y tareas del holding activo (validado por `HoldingScopeGuard`). */
	async getHome(holdingId: string, asOf = new Date()): Promise<Record<string, unknown>> {
		const date = asOf.toISOString().slice(0, 10);

		// MRR y clientes activos: definición compartida con Clientes (HoldingMetricsService), con el corte U14 del legacy (sin doble conteo).
		// Tareas: la misma función que el centro de notificaciones (TasksService).
		// fx_projected: monedas del MRR del mes convertidas con tasa fija proyectada (sin tasa registrada del holding para el mes).
		const month = `${date.slice(0, 7)}-01`;
		const [metrics, recognizedRevenue, invoices, holdingTasks, fxProjected] = await Promise.all([
			this.holdingMetrics.monthMetrics(holdingId, date, { legacyCut: true }),
			this.getRecognizedRevenue(holdingId, date),
			this.getInvoiceSummary(holdingId, date),
			this.tasksService.forHolding(holdingId, date),
			loadFxProjected(this.dataSource, holdingId, month, month),
		]);
		const countOf = (key: string) => holdingTasks.tasks.find((task) => task.key === key)?.count ?? 0;
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
			fx_projected: fxProjected,
			// Claves de siempre (front actual) + `items`: las tareas con algo por hacer, con enlace (refresh de Tareas pendientes, fase 2).
			tasks: {
				overdue_invoices: countOf('invoices_overdue'),
				expired_contracts: holdingTasks.dashboard.expired_contracts,
				contracts_to_renew_30: holdingTasks.dashboard.renew_30,
				contracts_to_renew_90: holdingTasks.dashboard.renew_90,
				invoices_to_emit: invoices.toIssue.count,
				items_starting_this_month: countOf('service_starts_this_month'),
				items: holdingTasks.tasks.filter((task) => task.count > 0),
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
}

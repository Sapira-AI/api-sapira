import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadMetricsHistoryStart } from '@/core/utils/holding-preferences';

import { decodeLineKey, eventDto, num, paginated, queryEvents, rawLineKey, type Row, str } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { lineCtes } from './onboarding-lines';

import type { OnboardingEventsQueryDto } from './dtos/onboarding.dto';

/** Resumen del onboarding de datos históricos (§4.1) y registro de cambios (§5 `GET /onboarding/events`). Solo lectura. */
@Injectable()
export class OnboardingService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly history: OnboardingHistoryService
	) {}

	async summary(holdingId: string, now = new Date()) {
		const today = await this.history.todayStart(holdingId, now);
		const [statuses, [clients], [splice], [invoices], [settings], metricsHistoryStart] = await Promise.all([
			this.dataSource.query(
				`${lineCtes({ holding: '$1', today: '$2' })} SELECT st.status, COUNT(*) AS lines, COUNT(*) FILTER (WHERE st.ended) AS ended FROM st GROUP BY st.status`,
				[holdingId, today]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COUNT(DISTINCT m.client_id) AS clients FROM mrr_legacy m
				WHERE m.holding_id = $1 AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.client_id = m.client_id AND c.holding_id = $1 AND c.deleted_at IS NULL)`,
				[holdingId]
			) as Promise<Row[]>,
			// Empalme por contrato (como la auditoría S8): último mes de MRR histórico empalmado vs primer mes con MRR del contrato.
			this.dataSource.query(
				`WITH first_rsm AS (
					SELECT r.contract_id, MIN(r.period_month) AS first_month FROM revenue_schedule_monthly r
					WHERE r.holding_id = $1 AND r.contract_id IS NOT NULL AND r.mrr_period_contracted_contract_ccy > 0 GROUP BY r.contract_id
				), linked AS (
					SELECT m.migrated_to_contract_id AS contract_id, MAX(m.period_month) AS last_month FROM mrr_legacy m
					WHERE m.holding_id = $1 AND m.migrated_to_contract_id IS NOT NULL GROUP BY m.migrated_to_contract_id
				)
				SELECT COUNT(*) FILTER (WHERE f.first_month IS NOT NULL AND l.last_month < f.first_month - interval '1 month') AS gap,
					COUNT(*) FILTER (WHERE f.first_month IS NOT NULL AND l.last_month >= f.first_month) AS overlap_cut,
					COUNT(*) FILTER (WHERE f.first_month IS NULL) AS contract_without_mrr
				FROM linked l LEFT JOIN first_rsm f ON f.contract_id = l.contract_id`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COUNT(*) AS total,
					COUNT(*) FILTER (WHERE il.contract_id IS NOT NULL) AS linked,
					COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)) AS without_history,
					COUNT(*) FILTER (WHERE il.status = 'Pagada') AS pagada,
					COUNT(*) FILTER (WHERE il.status = 'Enviada') AS enviada,
					COUNT(*) FILTER (WHERE il.status = 'Vencida') AS vencida
				FROM invoices_legacy il WHERE il.holding_id = $1`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
			loadMetricsHistoryStart(this.dataSource, holdingId),
		]);
		const count = (status: string) => num(statuses.find((row) => row.status === status)?.lines);

		return {
			history: {
				lines: statuses.reduce((sum, row) => sum + num(row.lines), 0),
				// Un solo estado pendiente (Domi 14-10): `pending` cuenta todas; `pending_ended` las que ya terminaron (subconjunto).
				pending: count('pending'),
				pending_ended: num(statuses.find((row) => row.status === 'pending')?.ended),
				linked: count('linked'),
				closed: count('closed'),
				removed: count('removed'),
				clients_without_contract: num(clients?.clients),
			},
			splice: { gap: num(splice?.gap), overlap_cut: num(splice?.overlap_cut), contract_without_mrr: num(splice?.contract_without_mrr) },
			// Domi 18-10: sin `pending` (sin contrato y sin histórico, se confundía con "sin registrar"). `without_history` + `with_history` =
			// `total`; `linked` = con contrato vinculado (con o sin histórico).
			previous_invoices: {
				total: num(invoices?.total),
				without_history: num(invoices?.without_history),
				with_history: num(invoices?.total) - num(invoices?.without_history),
				linked: num(invoices?.linked),
				by_status: { Pagada: num(invoices?.pagada), Enviada: num(invoices?.enviada), Vencida: num(invoices?.vencida) },
			},
			settings: { metrics_history_start: metricsHistoryStart, system_currency: str(settings?.system_currency) ?? 'USD' },
		};
	}

	async events(holdingId: string, query: OnboardingEventsQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 25;
		const params: unknown[] = [holdingId];
		const where = ['e.holding_id = $1'];

		if (query.lineKey) where.push(`e.line_key = $${params.push(rawLineKey(decodeLineKey(query.lineKey)))}`);
		if (query.entityId) where.push(`e.entity_id = $${params.push(query.entityId)}`);
		const rows = await queryEvents(
			this.dataSource,
			`SELECT e.*, u.name AS actor_name, COUNT(*) OVER () AS total_count
			FROM onboarding_events e LEFT JOIN users u ON u.id = e.actor_id
			WHERE ${where.join(' AND ')}
			ORDER BY e.created_at DESC
			LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`,
			params
		);

		return paginated(rows.map(eventDto), num(rows[0]?.total_count), page, limit);
	}
}

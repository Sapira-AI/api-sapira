import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadMetricsHistoryStart } from '@/core/utils/holding-preferences';
import {
	LEGACY_FIRST_RSM_JOIN,
	legacyAfterContractSql,
	legacyFirstRsmCte,
	legacyRemovedSql,
	legacySeamMonthSql,
} from '@/modules/metrics/mrr-historico';

import { decodeRootKey, eventDto, num, paginated, queryEvents, rawRootKey, type Row, str } from './onboarding-common';
import { lineCtes } from './onboarding-lines';

import type { OnboardingEventsQueryDto } from './dtos/onboarding.dto';

/** Resumen del onboarding de datos históricos (§4.1) y registro de cambios (§5 `GET /onboarding/events`). Solo lectura. */
@Injectable()
export class OnboardingService {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * `history` cuenta **registros** (`batch_id` × cliente × moneda × contrato, Domi 18-10: cada uno con un solo estado, tres estados). Sin
	 * `clients_without_contract`, `pending_ended` ni `removed` desde el 18-10.
	 */
	async summary(holdingId: string) {
		const [statuses, [splice], [seams], [invoices], [settings], metricsHistoryStart] = await Promise.all([
			this.dataSource.query(`${lineCtes({ holding: '$1' })} SELECT st.status, COUNT(*) AS records FROM st GROUP BY st.status`, [
				holdingId,
			]) as Promise<Row[]>,
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
					COUNT(*) FILTER (WHERE f.first_month IS NULL) AS contract_without_mrr
				FROM linked l LEFT JOIN first_rsm f ON f.contract_id = l.contract_id`,
				[holdingId]
			) as Promise<Row[]>,
			// Domi 18-10: el corte U14 se reporta en dos casos sobre las filas recurrentes no quitadas empalmadas. Mes de empalme (mismo mes que
			// el primer mes con MRR del contrato: normal, informativo) por registro; histórico después del inicio del contrato (error de datos)
			// en meses (registro × mes), registros y contratos.
			this.dataSource.query(
				`WITH ${legacyFirstRsmCte('$1')}
				SELECT COUNT(DISTINCT (m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id))
						FILTER (WHERE ${legacySeamMonthSql()}) AS seam_months,
					COUNT(DISTINCT (m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id, m.period_month)) FILTER (WHERE ${legacyAfterContractSql()}) AS after_months,
					COUNT(DISTINCT (m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id)) FILTER (WHERE ${legacyAfterContractSql()}) AS after_records,
					COUNT(DISTINCT m.migrated_to_contract_id) FILTER (WHERE ${legacyAfterContractSql()}) AS after_contracts
				FROM mrr_legacy m ${LEGACY_FIRST_RSM_JOIN}
				WHERE m.holding_id = $1 AND m.migrated_to_contract_id IS NOT NULL AND COALESCE(m.is_recurring, false) = true AND NOT ${legacyRemovedSql()}`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COUNT(*) AS total,
					COUNT(*) FILTER (WHERE il.contract_id IS NOT NULL) AS linked,
					COUNT(*) FILTER (WHERE il.reconciled_invoice_id IS NOT NULL) AS adopted,
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
		const count = (status: string) => num(statuses.find((row) => row.status === status)?.records);

		return {
			history: {
				records: statuses.reduce((sum, row) => sum + num(row.records), 0),
				pending: count('pending'),
				linked: count('linked'),
				// Clave estable `closed`; la etiqueta visible es "No activado" (Domi 18-10): marcadas sin código explícito o con `churn`.
				closed: count('closed'),
			},
			splice: {
				gap: num(splice?.gap),
				seam_months: num(seams?.seam_months),
				history_after_contract: {
					months: num(seams?.after_months),
					records: num(seams?.after_records),
					contracts: num(seams?.after_contracts),
				},
				contract_without_mrr: num(splice?.contract_without_mrr),
			},
			// Domi 18-10: sin `pending` (sin contrato y sin histórico, se confundía con "sin registrar"). `without_history` + `with_history` =
			// `total`; `linked` = con contrato vinculado (con o sin histórico).
			previous_invoices: {
				total: num(invoices?.total),
				without_history: num(invoices?.without_history),
				with_history: num(invoices?.total) - num(invoices?.without_history),
				linked: num(invoices?.linked),
				// Adoptadas como factura del contrato (§4.5): `reconciled_invoice_id` apunta a la factura de Sapira que nació de la previa.
				adopted: num(invoices?.adopted),
				by_status: { Pagada: num(invoices?.pagada), Enviada: num(invoices?.enviada), Vencida: num(invoices?.vencida) },
			},
			settings: { metrics_history_start: metricsHistoryStart, system_currency: str(settings?.system_currency) ?? 'USD' },
		};
	}

	/** `lineKey` acepta la clave de un registro (4 partes) o su raíz (3): el historial se guarda y se busca por la **raíz**. */
	async events(holdingId: string, query: OnboardingEventsQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 25;
		const params: unknown[] = [holdingId];
		const where = ['e.holding_id = $1'];

		if (query.lineKey) where.push(`e.line_key = $${params.push(rawRootKey(decodeRootKey(query.lineKey)))}`);
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

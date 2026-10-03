import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { renderDigestEmail } from '@/auth/accounts/email-templates/digest';
import { RenderedEmail } from '@/auth/accounts/email-templates/layout';
import { holdingTimezone } from '@/core/utils/holding-preferences';
import { MrrMetricsService } from '@/modules/metrics/mrr-metrics.service';
import { defaultWeeklyDigestFor, SEVERITY_LABELS, SEVERITY_RANK, WEEKLY_DIGEST_PREFERENCE } from '@/modules/notifications/notification-catalog';
import { NotificationEmailService } from '@/modules/notifications/notification-email.service';
import { MY_COMPANIES_SQL, NotificationsService } from '@/modules/notifications/notifications.service';
import { TasksService } from '@/modules/tasks/tasks.service';

import { localParts, mondayOf, money, monthName, signedMoney, weekLabel } from './local-time';

type Row = Record<string, unknown>;

export interface DigestUser {
	id: string;
	email: string;
	name: string | null;
	role_name: string | null;
}

const addMonth = (month: string, delta: number) => {
	const [year, value] = month.split('-').map(Number);
	const date = new Date(Date.UTC(year, value - 1 + delta, 1));

	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Resumen semanal por correo (Notificaciones v2 fase 2, contrato §8.4). Contenido por usuario y respetando sus "Mis compañías": tareas
 * abiertas por módulo (`TasksService`, la misma fuente del centro y el Dashboard), alertas abiertas de los últimos 7 días, MRR del mes vs el
 * anterior con mayores aumentos y pérdidas por cliente (`MrrMetricsService`, sin recalcular) y renovaciones ejecutadas en la semana.
 * Idempotente por semana (`notification_email_log`, clave `digest:<holding>:<lunes>`).
 */
@Injectable()
export class NotificationDigestService {
	private readonly logger = new Logger(NotificationDigestService.name);

	constructor(
		@InjectDataSource() private readonly dataSource: DataSource,
		private readonly tasks: TasksService,
		private readonly mrr: MrrMetricsService,
		private readonly notifications: NotificationsService,
		private readonly emails: NotificationEmailService
	) {}

	/** Usuarios activos del holding con resumen semanal (preferencia o default: Administrador y Finanzas). */
	async recipients(holdingId: string): Promise<DigestUser[]> {
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT u.id, u.email, u.name, r.name AS role_name, p.email AS digest
			FROM user_holdings uh
			JOIN users u ON u.id = uh.user_id
			LEFT JOIN roles r ON r.id = u.role_id
			LEFT JOIN user_notification_preferences p ON p.user_id = u.id AND p.holding_id = $1 AND p.notification_type = $2
			WHERE uh.holding_id = $1 AND uh.is_active = true AND u.status = 'Activo' AND COALESCE(u.email, '') <> ''`,
			[holdingId, WEEKLY_DIGEST_PREFERENCE]
		)) as Row[];

		return (rows ?? [])
			.filter((row) =>
				row.digest === null || row.digest === undefined ? defaultWeeklyDigestFor(row.role_name as string | null) : row.digest === true
			)
			.map((row) => ({
				id: String(row.id),
				email: String(row.email),
				name: row.name ? String(row.name) : null,
				role_name: row.role_name ? String(row.role_name) : null,
			}));
	}

	/** Envía el resumen de la semana a quienes lo tienen activo. Devuelve cuántos salieron (los ya enviados esta semana se omiten). */
	async run(holdingId: string, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
		const result = { sent: 0, skipped: 0, failed: 0 };

		if (!this.emails.enabled) return result;
		const timezone = await holdingTimezone(this.dataSource, holdingId);
		const monday = mondayOf(localParts(now, timezone).date);

		for (const user of await this.recipients(holdingId)) {
			try {
				const email = await this.build(holdingId, user, now);
				const status = await this.emails.deliver({
					holdingId,
					userId: user.id,
					to: user.email,
					kind: 'digest',
					key: `digest:${holdingId}:${monday}`,
					email,
				});

				result[status] += 1;
			} catch (error) {
				result.failed += 1;
				this.logger.warn(`Resumen semanal de ${user.id} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return result;
	}

	/** Vista previa (`POST /notifications/digest/preview`, solo super admin): el resumen del holding para quien llama. No envía ni registra. */
	async preview(holdingId: string, authUserId: string, now = new Date()): Promise<RenderedEmail> {
		const [row] = (await this.dataSource.query(
			`SELECT u.id, u.email, u.name, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.auth_id = $1`,
			[authUserId]
		)) as Row[];

		return this.build(
			holdingId,
			{
				id: String(row?.id ?? ''),
				email: String(row?.email ?? ''),
				name: row?.name ? String(row.name) : null,
				role_name: row?.role_name ? String(row.role_name) : null,
			},
			now
		);
	}

	/** Arma el correo del usuario (respeta "Mis compañías"). */
	async build(holdingId: string, user: DigestUser, now = new Date()): Promise<RenderedEmail> {
		const timezone = await holdingTimezone(this.dataSource, holdingId);
		const today = localParts(now, timezone).date;
		const companies = user.id ? await this.notifications.myCompanies(holdingId, user.id) : [];
		const [[holding], tasks, alerts, mrr, renewals] = await Promise.all([
			this.dataSource.query(`SELECT name FROM company_holdings WHERE id = $1`, [holdingId]) as Promise<Row[]>,
			this.tasks.pending(holdingId, today, companies),
			this.alerts(holdingId, user.id),
			this.mrrSection(holdingId, today.slice(0, 7), companies),
			this.renewals(holdingId, companies),
		]);
		const holdingName = String(holding?.name ?? 'tu holding');
		const companyNames = companies.length
			? (
					(await this.dataSource.query(`SELECT legal_name FROM companies WHERE id = ANY($1::uuid[]) ORDER BY legal_name`, [
						companies,
					])) as Row[]
				).map((row) => String(row.legal_name))
			: [];

		return renderDigestEmail({
			name: user.name,
			holdingName,
			weekLabel: weekLabel(mondayOf(today)),
			url: this.emails.appUrl('/lab/notificaciones'),
			tasks: tasks.tasks.map((task) => ({
				module: task.module_label,
				title: task.title,
				count: task.count,
				url: this.emails.appUrl(task.href),
			})),
			alerts,
			mrr,
			renewals,
			companiesNote: companyNames.length ? `Incluye solo tus compañías: ${companyNames.join(', ')}.` : null,
			logoUrl: this.emails.logoUrl(),
		});
	}

	/** Alertas abiertas del usuario creadas en los últimos 7 días (sin archivadas, con "Mis compañías"): total + las 8 más graves. */
	private async alerts(holdingId: string, userId: string) {
		if (!userId) return { total: 0, items: [] };
		const rows = (await this.dataSource.query(
			`SELECT n.id, n.title, n.severity, n.created_at
			FROM app_notification_recipients r JOIN app_notifications n ON n.id = r.notification_id
			WHERE r.user_id = $1 AND n.holding_id = $2 AND n.status = 'open' AND r.archived_at IS NULL
				AND n.created_at >= now() - interval '7 days' AND ${MY_COMPANIES_SQL}
			ORDER BY n.created_at DESC LIMIT 200`,
			[userId, holdingId]
		)) as Row[];
		const sorted = [...(rows ?? [])].sort((a, b) => (SEVERITY_RANK[b.severity as 'error'] ?? 0) - (SEVERITY_RANK[a.severity as 'error'] ?? 0));

		return {
			total: sorted.length,
			items: sorted.slice(0, 8).map((row) => ({
				title: String(row.title),
				severity: SEVERITY_LABELS[row.severity as 'error'] ?? String(row.severity),
				url: this.emails.alertUrl(String(row.id)),
			})),
		};
	}

	/** MRR del mes vs el anterior (`overview`) y los 3 mayores aumentos y pérdidas por cliente del mes (`movementDetail`). */
	private async mrrSection(holdingId: string, month: string, companies: string[]) {
		try {
			const companyId = companies.length ? companies.join(',') : undefined;
			const [overview, detail] = await Promise.all([
				this.mrr.overview(holdingId, { asOf: month, ...(companyId ? { companyId } : {}) }),
				this.mrr.movementDetail(holdingId, { from: month, to: month, groupBy: 'client', limit: 1000, ...(companyId ? { companyId } : {}) }),
			]);
			const kpi = overview.kpis.mrr;
			const currency = overview.currency;
			const delta = Number(kpi.delta ?? 0);
			const label = (row: { client_name: string | null }) => row.client_name ?? 'Cliente sin nombre';

			return {
				month: monthName(month),
				previousMonth: monthName(addMonth(month, -1)),
				value: money(kpi.value, currency),
				previous: money(kpi.previous, currency),
				delta: signedMoney(delta, currency),
				deltaTone: delta > 0 ? ('up' as const) : delta < 0 ? ('down' as const) : null,
				increases: detail.data
					.filter((row) => row.amount > 0)
					.sort((a, b) => b.amount - a.amount)
					.slice(0, 3)
					.map((row) => ({ label: label(row), value: signedMoney(row.amount, currency) })),
				decreases: detail.data
					.filter((row) => row.amount < 0)
					.sort((a, b) => a.amount - b.amount)
					.slice(0, 3)
					.map((row) => ({ label: label(row), value: signedMoney(row.amount, currency) })),
			};
		} catch (error) {
			this.logger.warn(`Resumen semanal: MRR del holding ${holdingId}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** Renovaciones ejecutadas en los últimos 7 días (eventos `RENEWAL` completados, también los `renewal` del flujo anterior). */
	private async renewals(holdingId: string, companies: string[]) {
		const rows = (await this.dataSource.query(
			`SELECT c.id, c.contract_number, cl.name_commercial, COUNT(*) OVER () AS total
			FROM contract_lifecycle_events e
			JOIN contracts c ON c.id = e.contract_id
			LEFT JOIN clients cl ON cl.id = c.client_id
			WHERE e.holding_id = $1 AND upper(e.event_type) = 'RENEWAL' AND lower(e.event_status) = 'completed'
				AND COALESCE(e.completed_at, e.created_at) >= now() - interval '7 days'
				AND (cardinality($2::uuid[]) = 0 OR c.company_id = ANY($2::uuid[]))
			ORDER BY COALESCE(e.completed_at, e.created_at) DESC
			LIMIT 8`,
			[holdingId, companies]
		)) as Row[];

		return {
			count: Number(rows?.[0]?.total ?? 0),
			items: (rows ?? []).map((row) => ({
				label: [row.contract_number, row.name_commercial].filter(Boolean).join(' · ') || 'Contrato',
				url: this.emails.appUrl(`/lab/contratos/${String(row.id)}`),
			})),
		};
	}
}

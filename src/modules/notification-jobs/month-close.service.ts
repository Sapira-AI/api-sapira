import { Injectable, Logger } from '@nestjs/common';

import { INVOICE_IDS_MAX } from '@/modules/contracts/dtos/contract-invoices.dto';
import { NOTIFICATION_ACTION_LABELS } from '@/modules/notifications/notification-catalog';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { monthCloseWindow, monthLabel, monthQueueHref } from '@/modules/tasks/tasks';
import { TasksService } from '@/modules/tasks/tasks.service';

import { money } from './local-time';

export const MONTH_CLOSE_NOTIFICATION_TYPE = 'month_close_pending';

/**
 * Aviso de cierre de mes (Notificaciones v2 fase 2, contrato §8.6): el último día hábil del mes y los 3 primeros días hábiles del siguiente,
 * una alerta `month_close_pending` **por compañía** con Por Emitir del mes a cerrar (misma consulta que la tarea, `TasksService.
 * monthCloseByCompany`). Escalón = mes + día de la ventana (vuelve a "sin leer" cada día). Se resuelve sola cuando la compañía queda en 0 o
 * al salir de la ventana. Acción `open_billing_queue` y secundaria "Mover al mes siguiente" con el endpoint masivo que ya existe en
 * Facturación (`POST /billing/to-issue/reschedule`, `shift_months: 1`).
 */
@Injectable()
export class MonthCloseService {
	private readonly logger = new Logger(MonthCloseService.name);

	constructor(
		private readonly tasks: TasksService,
		private readonly notifications: NotificationsService
	) {}

	async run(holdingId: string, today: string): Promise<{ month: string | null; alerts: number; resolved: number }> {
		const window = monthCloseWindow(today);
		const open = await this.notifications.listOpen(holdingId, MONTH_CLOSE_NOTIFICATION_TYPE);

		if (!window) {
			const resolved = await this.notifications.resolveOpen(holdingId, { ids: open.map((item) => item.id) });

			return { month: null, alerts: 0, resolved };
		}
		const [rows, currency] = await Promise.all([this.tasks.monthCloseByCompany(holdingId, window.month), this.tasks.currency(holdingId)]);
		const keys = new Set<string>();
		let alerts = 0;

		for (const row of rows.filter((item) => item.count > 0)) {
			const key = `month-close:${window.month}:${row.company_id ?? 'none'}`;
			const label = monthLabel(window.month);
			const plural = row.count === 1;
			const href = monthQueueHref(window.month, row.company_id ? [row.company_id] : []);
			const invoiceIds = row.invoice_ids.slice(0, INVOICE_IDS_MAX);

			keys.add(key);
			try {
				const result = await this.notifications.createOrUpdate(holdingId, {
					source: 'billing',
					type: MONTH_CLOSE_NOTIFICATION_TYPE,
					severity: 'warning',
					title: `${row.count} ${plural ? 'factura Por Emitir' : 'facturas Por Emitir'} de ${label} ${plural ? 'sigue' : 'siguen'} sin emitir${
						row.company_name ? ` · ${row.company_name}` : ''
					}`,
					message:
						window.step === 0
							? `Hoy es el último día hábil de ${label} y quedan ${row.count} por ${money(row.amount, currency)}.`
							: `${label[0].toUpperCase()}${label.slice(1)} ya cerró y quedan ${row.count} por ${money(row.amount, currency)} sin emitir.`,
					recommendation: 'Emítelas desde la cola Por Emitir o muévelas al mes siguiente si corresponden a ese período.',
					action_type: 'open_billing_queue',
					action_payload: {
						month: window.month,
						company_id: row.company_id,
						href,
						invoice_ids: invoiceIds,
						secondary: {
							type: 'move_to_next_month',
							label: NOTIFICATION_ACTION_LABELS.move_to_next_month,
							method: 'POST',
							endpoint: '/billing/to-issue/reschedule',
							preview_endpoint: '/billing/to-issue/reschedule/preview',
							body: { invoice_ids: invoiceIds, shift_months: 1 },
							complete: row.count <= invoiceIds.length,
						},
					},
					metadata: { month: window.month, count: row.count, amount: row.amount, currency },
					...(row.company_id ? { company_id: row.company_id } : {}),
					escalation_step: `${window.month}:${window.step}`,
					deduplication_key: key,
				});

				if (result.notification) alerts += 1;
			} catch (error) {
				this.logger.warn(`Cierre de mes ${window.month} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const stale = open.filter((item) => !item.deduplication_key || !keys.has(item.deduplication_key)).map((item) => item.id);
		const resolved = await this.notifications.resolveOpen(holdingId, { ids: stale });

		return { month: window.month, alerts, resolved };
	}
}

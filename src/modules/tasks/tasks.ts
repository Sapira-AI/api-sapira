/**
 * Tareas del holding (Notificaciones v2, `docs/v2-rediseno/contrato-api-notificaciones.md` §4): cosas que **hay que hacer hoy**, calculadas
 * en vivo desde los módulos (no se guardan). Este archivo es puro: arma la lista de tareas con sus enlaces al front nuevo (`/lab/...` con
 * los parámetros que esas pantallas leen) a partir de los conteos que junta `TasksService`. Lo usan el centro (`GET /notifications/tasks`)
 * y el Dashboard (`GET /dashboard/home`): una sola definición.
 */
import { NOTIFICATION_MODULES, type NotificationModule } from '@/modules/notifications/notification-catalog';

export type TaskSeverity = 'error' | 'warning' | 'info';

export interface Task {
	key: string;
	module: NotificationModule;
	module_label: string;
	title: string;
	count: number;
	/** Monto en moneda del sistema; null si no aplica. */
	amount: number | null;
	currency: string | null;
	severity: TaskSeverity;
	href: string;
	breakdown?: Array<{ key: string; label: string; count: number; href: string }>;
}

export interface Bucket {
	count: number;
	amount?: number | null;
	/** Moneda del monto si no es la del sistema (cotizaciones: la de la cotización). */
	currency?: string | null;
	/** Hasta 2 contratos distintos: con uno solo, el enlace va a su 360. */
	contract_ids?: string[];
}

export interface TaskInputs {
	today: string;
	currency: string;
	queue: {
		ready: Bucket;
		late: Bucket;
		blocked: Bucket & { reasons: Array<{ code: string; label: string; count: number }> };
		past_months: Bucket & { first_month: string | null };
	};
	overdue: Bucket;
	credit_notes: Bucket;
	proposals: Bucket;
	expired: Bucket;
	pacts: Bucket;
	consumptions: Bucket;
	without_invoices: Bucket;
	starts: Bucket;
	waiting_mapping: Bucket;
	quotes_unprocessed: Bucket;
	revenue_exceptions: Bucket;
}

const SEVERITY_ORDER: Record<TaskSeverity, number> = { error: 0, warning: 1, info: 2 };
const PENDING = 'Por+Emitir';

/** Último día del mes de `date` (`YYYY-MM-DD`). */
export function monthBounds(date: string): { first: string; last: string; month: string; previousMonth: string } {
	const [year, month] = date.split('-').map(Number);
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const previous = new Date(Date.UTC(year, month - 2, 1));
	const pad = (value: number) => String(value).padStart(2, '0');

	return {
		first: `${year}-${pad(month)}-01`,
		last: `${year}-${pad(month)}-${pad(last)}`,
		month: `${year}-${pad(month)}`,
		previousMonth: `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth() + 1)}`,
	};
}

const contractHref = (bucket: Bucket, listHref: string, tab?: string) =>
	bucket.count > 0 && bucket.contract_ids?.length === 1 ? `/lab/contratos/${bucket.contract_ids[0]}${tab ? `?tab=${tab}` : ''}` : listHref;

/** Todas las tareas (también las en cero), en orden por gravedad. El centro muestra solo las con conteo. */
export function buildTasks(input: TaskInputs): Task[] {
	const { first, last, previousMonth } = monthBounds(input.today);
	const task = (
		key: string,
		module: NotificationModule,
		title: string,
		bucket: Bucket,
		severity: TaskSeverity,
		href: string,
		withAmount = false
	): Task => ({
		key,
		module,
		module_label: NOTIFICATION_MODULES[module],
		title,
		count: bucket.count,
		amount: withAmount ? (bucket.amount ?? null) : null,
		currency: withAmount && bucket.amount !== null && bucket.amount !== undefined ? (bucket.currency ?? input.currency) : null,
		severity,
		href,
	});
	const blockedHref = `/lab/facturacion?estado=${PENDING}&grupo=blocked&periodo=todo`;
	const tasks: Task[] = [
		task(
			'invoices_to_issue_today',
			'facturacion',
			'Facturas por emitir hoy',
			input.queue.ready,
			'info',
			`/lab/facturacion?estado=${PENDING}&grupo=ready`,
			true
		),
		{
			...task('invoices_blocked', 'facturacion', 'Facturas por emitir bloqueadas', input.queue.blocked, 'error', blockedHref, true),
			breakdown: input.queue.blocked.reasons.map((reason) => ({
				key: reason.code,
				label: reason.label,
				count: reason.count,
				href: `${blockedHref}&motivo=${encodeURIComponent(reason.code)}`,
			})),
		},
		task(
			'invoices_late',
			'facturacion',
			'Facturas por emitir atrasadas',
			input.queue.late,
			'warning',
			`/lab/facturacion?estado=${PENDING}&grupo=late&periodo=todo`,
			true
		),
		task(
			'invoices_past_months',
			'facturacion',
			'Por emitir de meses pasados',
			input.queue.past_months,
			'warning',
			`/lab/facturacion?estado=${PENDING}&desde=${input.queue.past_months.first_month ?? previousMonth}&hasta=${previousMonth}`,
			true
		),
		task('invoices_overdue', 'facturacion', 'Facturas vencidas', input.overdue, 'warning', '/lab/facturacion?pago=overdue&periodo=todo', true),
		task(
			'credit_notes_to_issue',
			'facturacion',
			'Notas de crédito por emitir',
			input.credit_notes,
			'warning',
			'/lab/facturacion?tab=notas-credito&dte=pending_emission&periodo=todo'
		),
		task(
			'renewals_to_decide',
			'contratos',
			'Renovaciones por confirmar',
			input.proposals,
			'warning',
			contractHref(input.proposals, '/lab/contratos?f=estado:pending_renewal')
		),
		task(
			'expirations_without_decision',
			'contratos',
			'Vencidos sin decisión',
			input.expired,
			'error',
			contractHref(input.expired, '/lab/contratos?f=estado:expired')
		),
		task(
			'scheduled_changes_due',
			'contratos',
			'Ajustes pactados por aplicar',
			input.pacts,
			'warning',
			contractHref(input.pacts, '/lab/contratos')
		),
		task(
			'consumptions_to_report',
			'contratos',
			'Consumos por informar',
			input.consumptions,
			'warning',
			contractHref(input.consumptions, '/lab/contratos', 'consumos')
		),
		task(
			'contracts_without_invoices',
			'contratos',
			'Contratos activos sin facturas programadas',
			input.without_invoices,
			'warning',
			contractHref(input.without_invoices, '/lab/contratos?f=estado:active')
		),
		task(
			'service_starts_this_month',
			'contratos',
			'Inicios de servicio del mes',
			input.starts,
			'info',
			`/lab/contratos?f=inicio_desde:${first};inicio_hasta:${last}`
		),
		task(
			'quotes_waiting_mapping',
			'cotizaciones',
			'Cotizaciones del CRM en espera de mapeo',
			input.waiting_mapping,
			'warning',
			'/lab/cotizaciones'
		),
		task(
			'quotes_unprocessed_this_month',
			'cotizaciones',
			'Cotizaciones firmadas del mes sin contrato',
			input.quotes_unprocessed,
			'warning',
			`/lab/cotizaciones?f=booking_desde:${first};booking_hasta:${last};con_contrato:no;estado:signed`,
			true
		),
		task('revenue_exceptions', 'ingresos', 'Excepciones de Ingresos', input.revenue_exceptions, 'warning', '/lab/revenue?tab=excepciones'),
	];

	return tasks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

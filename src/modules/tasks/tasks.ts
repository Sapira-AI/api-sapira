/**
 * Tareas del holding (Notificaciones v2, `docs/v2-rediseno/contrato-api-notificaciones.md` §4): cosas que **hay que hacer hoy**, calculadas
 * en vivo desde los módulos (no se guardan). Este archivo es puro: arma la lista de tareas con sus enlaces a las rutas finales del front (`/facturacion`, `/contratos`… con
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
	/** Qué hacer para cerrar la tarea (tooltip del centro). */
	hint?: string;
	breakdown?: Array<{ key: string; label: string; count: number; href: string; amount?: number | null; hint?: string }>;
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
		/**
		 * Por emitir atrasadas (Domi 05-10: una sola tarea en vez de "atrasadas", "de meses pasados" y "siguen sin emitir", que contaban las
		 * mismas facturas): Por Emitir no bloqueadas cuya fecha de emisión ya pasó, por antigüedad (este mes, mes anterior, más antiguas).
		 * `first_month` (`YYYY-MM`): primer mes de las facturas; arma el enlace `desde=…&hasta=<mes en curso>`.
		 */
		late: Bucket & {
			first_month?: string | null;
			this_month?: Bucket;
			previous_month?: Bucket;
			older?: Bucket & { first_month?: string | null };
		};
		/** Sin el motivo `no_contract` (facturas sin contrato: datos a sanear, no una tarea). */
		blocked: Bucket & {
			first_month?: string | null;
			reasons: Array<{ code: string; label: string; count: number; first_month?: string | null }>;
		};
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
	/** Compañías aplicadas ("Mis compañías"): se agregan al enlace de Facturación. */
	company_ids?: string[];
}

/**
 * Tareas cuyas fuentes **no distinguen compañía** (cotizaciones del CRM y excepciones de Ingresos): se cuentan a nivel holding y no entran
 * en conteos por compañía (resumen semanal, "Por compañía"), donde se repetirían en cada una.
 */
export const HOLDING_WIDE_TASK_KEYS: readonly string[] = ['quotes_waiting_mapping', 'quotes_unprocessed_this_month', 'revenue_exceptions'];

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

const pad2 = (value: number) => String(value).padStart(2, '0');
const isoDay = (date: Date) => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const isBusinessDay = (date: Date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "octubre de 2026" desde `YYYY-MM`. */
export const monthLabel = (month: string) => {
	const [year, value] = month.split('-').map(Number);

	return `${MONTH_NAMES[value - 1] ?? month} de ${year}`;
};

/**
 * Ventana del aviso de cierre de mes (contrato §8.6): el **último día hábil** del mes M y los **3 primeros días hábiles** de M+1 (lunes a
 * viernes, sin feriados). Devuelve el mes a cerrar (M) y el escalón (0 = último hábil de M, 1–3 = días hábiles de M+1), o null fuera de ella.
 */
export function monthCloseWindow(today: string): { month: string; step: number } | null {
	const [year, month, day] = today.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));

	if (!isBusinessDay(date)) return null;
	// ¿Último hábil del mes?
	const last = new Date(Date.UTC(year, month, 0));

	while (!isBusinessDay(last)) last.setUTCDate(last.getUTCDate() - 1);
	if (isoDay(last) === today) return { month: `${year}-${pad2(month)}`, step: 0 };
	// ¿Uno de los 3 primeros hábiles del mes?
	let count = 0;

	for (let cursor = new Date(Date.UTC(year, month - 1, 1)); cursor <= date; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
		if (isBusinessDay(cursor)) count += 1;
	}
	if (count >= 1 && count <= 3) {
		const previous = new Date(Date.UTC(year, month - 2, 1));

		return { month: `${previous.getUTCFullYear()}-${pad2(previous.getUTCMonth() + 1)}`, step: count };
	}

	return null;
}

/** Cola Por emitir de un mes (y compañías) en Facturación del front nuevo. */
export const monthQueueHref = (month: string, companyIds: string[] = []) =>
	`/facturacion?estado=Por+Emitir&desde=${month}&hasta=${month}${companyIds.length ? `&company_id=${companyIds.join(',')}` : ''}`;

const contractHref = (bucket: Bucket, listHref: string, tab?: string) =>
	bucket.count > 0 && bucket.contract_ids?.length === 1 ? `/contratos/${bucket.contract_ids[0]}${tab ? `?tab=${tab}` : ''}` : listHref;

/**
 * Rango de la cola Por emitir de una tarea: la tarea cuenta hasta hoy, así que el enlace abre desde el primer mes de sus facturas hasta el
 * mes en curso (`periodo=todo` abriría también las futuras). Sin fecha conocida, toda la cola.
 */
export const queueRange = (firstMonth: string | null | undefined, currentMonth: string) =>
	firstMonth ? `desde=${firstMonth}&hasta=${firstMonth > currentMonth ? firstMonth : currentMonth}` : 'periodo=todo';

/** `YYYY-MM` del mes anterior a `month` (`YYYY-MM`). */
const monthBefore = (month: string) => monthBounds(`${month}-01`).previousMonth;

/** Cómo se cierran las Por emitir atrasadas (tooltip de la tarea). */
export const LATE_HINT =
	'Para cerrarlas: emite las que corresponden; reprograma las que deben salir en otra fecha; y si el cliente se fue o redujo su plan, regístralo en el contrato (Modificar contrato) para que las facturas que sobran se cancelen.';

/** Todas las tareas (también las en cero), en orden por gravedad. El centro muestra solo las con conteo. */
export function buildTasks(input: TaskInputs): Task[] {
	const { first, last, month, previousMonth } = monthBounds(input.today);
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
	const blockedBase = `/facturacion?estado=${PENDING}&grupo=blocked`;
	const tasks: Task[] = [
		task(
			'invoices_to_issue_today',
			'facturacion',
			'Facturas por emitir hoy',
			input.queue.ready,
			'info',
			`/facturacion?estado=${PENDING}&grupo=ready`,
			true
		),
		{
			...task(
				'invoices_late',
				'facturacion',
				'Facturas por emitir atrasadas',
				input.queue.late,
				'warning',
				`/facturacion?estado=${PENDING}&grupo=late&${queueRange(input.queue.late.first_month, month)}`,
				true
			),
			hint: LATE_HINT,
			breakdown: [
				{
					key: 'this_month',
					label: 'Este mes',
					bucket: input.queue.late.this_month,
					href: `/facturacion?estado=${PENDING}&grupo=late&desde=${month}&hasta=${month}`,
					hint: 'Su fecha de emisión ya pasó: emítelas o, si se adelantó o atrasó el cobro, reprográmalas.',
				},
				{
					key: 'previous_month',
					label: 'Mes anterior',
					bucket: input.queue.late.previous_month,
					href: `/facturacion?estado=${PENDING}&grupo=late&desde=${previousMonth}&hasta=${previousMonth}`,
					hint: 'Del mes que se está cerrando: emítelas con fecha de ese mes o, si corresponden al siguiente, reprográmalas.',
				},
				{
					key: 'older',
					label: 'Más antiguas',
					bucket: input.queue.late.older,
					href: `/facturacion?estado=${PENDING}&grupo=late&${queueRange(input.queue.late.older?.first_month ?? null, monthBefore(previousMonth))}`,
					hint: 'Llevan más de un mes: confirma si el servicio siguió. Si el cliente se fue o redujo, regístralo en el contrato (Modificar contrato › Termina el contrato o Quitó un producto) y las facturas que sobran se cancelan; si siguió, emítelas o reprográmalas.',
				},
			]
				.filter((part) => (part.bucket?.count ?? 0) > 0)
				.map(({ bucket, ...part }) => ({ ...part, count: bucket!.count, amount: bucket!.amount ?? null })),
		},
		{
			...task(
				'invoices_blocked',
				'facturacion',
				'Facturas por emitir bloqueadas',
				input.queue.blocked,
				'error',
				`${blockedBase}&${queueRange(input.queue.blocked.first_month, month)}`,
				true
			),
			breakdown: input.queue.blocked.reasons.map((reason) => ({
				key: reason.code,
				label: reason.label,
				count: reason.count,
				href: `${blockedBase}&${queueRange(reason.first_month, month)}&motivo=${encodeURIComponent(reason.code)}`,
			})),
		},
		task('invoices_overdue', 'facturacion', 'Facturas vencidas', input.overdue, 'warning', '/facturacion?pago=overdue&periodo=todo', true),
		task(
			'credit_notes_to_issue',
			'facturacion',
			'Notas de crédito por emitir',
			input.credit_notes,
			'warning',
			'/facturacion?tab=notas-credito&dte=pending_emission&periodo=todo'
		),
		task(
			'renewals_to_decide',
			'contratos',
			'Renovaciones por confirmar',
			input.proposals,
			'warning',
			contractHref(input.proposals, '/contratos?f=estado:pending_renewal')
		),
		task(
			'expirations_without_decision',
			'contratos',
			'Vencidos sin decisión',
			input.expired,
			'error',
			contractHref(input.expired, '/contratos?f=estado:expired')
		),
		task('scheduled_changes_due', 'contratos', 'Ajustes pactados por aplicar', input.pacts, 'warning', contractHref(input.pacts, '/contratos')),
		task(
			'consumptions_to_report',
			'contratos',
			'Consumos por informar',
			input.consumptions,
			'warning',
			contractHref(input.consumptions, '/contratos', 'consumos')
		),
		task(
			'contracts_without_invoices',
			'contratos',
			'Contratos activos sin facturas programadas',
			input.without_invoices,
			'warning',
			contractHref(input.without_invoices, '/contratos?f=estado:active')
		),
		task(
			'service_starts_this_month',
			'contratos',
			'Inicios de servicio del mes',
			input.starts,
			'info',
			`/contratos?f=inicio_desde:${first};inicio_hasta:${last}`
		),
		task('quotes_waiting_mapping', 'cotizaciones', 'Cotizaciones del CRM en espera de mapeo', input.waiting_mapping, 'warning', '/cotizaciones'),
		task(
			'quotes_unprocessed_this_month',
			'cotizaciones',
			'Cotizaciones firmadas del mes sin contrato',
			input.quotes_unprocessed,
			'warning',
			`/cotizaciones?f=booking_desde:${first};booking_hasta:${last};con_contrato:no;estado:signed`,
			true
		),
		task('revenue_exceptions', 'ingresos', 'Excepciones de Ingresos', input.revenue_exceptions, 'warning', '/ingresos?tab=excepciones'),
	];

	const companies = input.company_ids ?? [];
	const withCompanies = (href: string) =>
		companies.length && href.startsWith('/facturacion') && !href.includes('company_id=')
			? `${href}${href.includes('?') ? '&' : '?'}company_id=${companies.join(',')}`
			: href;

	return tasks
		.map((item) => ({
			...item,
			href: withCompanies(item.href),
			...(item.breakdown ? { breakdown: item.breakdown.map((part) => ({ ...part, href: withCompanies(part.href) })) } : {}),
		}))
		.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

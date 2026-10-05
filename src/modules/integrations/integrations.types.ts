/**
 * Integraciones v2 (`docs/v2-rediseno/contrato-api-integraciones.md`): tipos, etiquetas y helpers puros (sin Nest ni base). Los usan los
 * adaptadores, el servicio y los tests.
 */
import type { FieldError } from '@/core/utils/validation-errors';

export const INTEGRATION_TIPOS = ['erp', 'crm', 'stripe', 'datos'] as const;
export type IntegrationTipo = (typeof INTEGRATION_TIPOS)[number];
export const isIntegrationTipo = (value: string): value is IntegrationTipo => (INTEGRATION_TIPOS as readonly string[]).includes(value);

export const TIPO_INFO: Record<
	IntegrationTipo,
	{ label: string; description: string; system: string; system_label: string; direction: 'import' | 'export' | 'both' }
> = {
	erp: { label: 'ERP', description: 'Facturas y clientes con tu sistema contable', system: 'odoo', system_label: 'Odoo', direction: 'both' },
	crm: {
		label: 'CRM',
		description: 'Oportunidades ganadas que llegan como cotizaciones',
		system: 'salesforce',
		system_label: 'Salesforce',
		direction: 'import',
	},
	stripe: {
		label: 'Invoices y suscripciones',
		description: 'Clientes, suscripciones e invoices de tus cuentas de Stripe',
		system: 'stripe',
		system_label: 'Stripe',
		direction: 'import',
	},
	datos: {
		label: 'Almacén de datos',
		description: 'Consumos para facturar productos variables',
		system: 'bigquery',
		system_label: 'BigQuery',
		direction: 'import',
	},
};

export const DIRECTION_LABELS = { import: 'Importa', export: 'Exporta', both: 'Exporta e importa' } as const;

/** Pestañas del 360 (D1). */
export const integrationHref = (tipo: IntegrationTipo, tab?: 'estado' | 'mapeos' | 'configuracion' | 'historial') =>
	`/conexiones/${tipo}${tab ? `?tab=${tab}` : ''}`;

// ── Registros (estado de sincronización, A2) ────────────────────────────────────────────────────────────────────────────────

export const RECORD_STATUSES = ['pending', 'ready', 'error', 'imported', 'synced', 'discarded', 'excluded_by_rule'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const RECORD_STATUS_LABELS: Record<RecordStatus, string> = {
	pending: 'Pendiente',
	ready: 'Listo para importar',
	error: 'Con error',
	imported: 'Importado',
	synced: 'Sincronizado',
	discarded: 'Descartado',
	excluded_by_rule: 'Excluido por regla',
};
/** Orden de la lista: primero lo no importado (ajuste 4 de Domi). */
export const RECORD_STATUS_RANK: Record<RecordStatus, number> = {
	error: 0,
	ready: 1,
	pending: 2,
	synced: 3,
	imported: 4,
	excluded_by_rule: 5,
	discarded: 6,
};

/** Equivalencia `processing_status` de las tablas intermedias → estado de la API (contrato §4). */
export function stagingStatus(raw: string | null | undefined): RecordStatus {
	switch ((raw ?? '').trim()) {
		case 'create':
		case 'update':
		case 'to_create':
		case 'to_update':
			return 'ready';
		case 'processed':
		case 'no_change':
		case 'integrated':
			return 'imported';
		case 'error':
		case 'invalid':
		case 'unmapped':
		case 'currency_mismatch':
		case 'blocked':
		case 'ambiguous':
		case 'conflict':
		case 'changed_in_source':
			return 'error';
		default:
			return 'pending';
	}
}

/** Lo mismo que `stagingStatus` en SQL, para filtrar y contar en la base. */
export const stagingStatusSql = (column: string) => `(CASE
	WHEN ${column} IN ('create','update','to_create','to_update') THEN 'ready'
	WHEN ${column} IN ('processed','no_change','integrated') THEN 'imported'
	WHEN ${column} IN ('error','invalid','unmapped','currency_mismatch','blocked','ambiguous','conflict','changed_in_source') THEN 'error'
	ELSE 'pending' END)`;

/** Qué haría importar un registro listo: crear uno nuevo en Sapira o aplicar cambios a uno existente (`null`: el adaptador no lo sabe). */
export const RECORD_CHANGE_KINDS = ['new', 'update'] as const;
export type RecordChangeKind = (typeof RECORD_CHANGE_KINDS)[number];
export const RECORD_CHANGE_KIND_LABELS: Record<RecordChangeKind, string> = { new: 'Nuevo', update: 'Cambio a existente' };
/** `status_label` de un cambio a un registro existente: va a "Por revisar" (`status = pending`), no a "Listo para importar". */
export const UPDATE_STATUS_LABEL = 'Cambios por revisar';

/** `processing_status` de las tablas intermedias → `change_kind` (`create` = nuevo, `update` = cambios a un registro que ya existe). */
export const stagingChangeKindSql = (column: string) => `(CASE
	WHEN ${column} IN ('create','to_create') THEN 'new'
	WHEN ${column} IN ('update','to_update') THEN 'update'
	ELSE NULL END)`;

/**
 * Fuente SQL de un objeto: selecciona `record_key, label, sapira_id, external_id, status, message, last_sync_at, rule_row` con `$1` =
 * holding. `rule_row` = la fila de la tabla intermedia como jsonb (las reglas de exclusión la leen por ruta).
 */
export interface RecordSource {
	object: string;
	label: string;
	/** Tabla intermedia (campos disponibles para reglas). */
	table: string;
	direction: 'import' | 'export';
	sql: string;
	/** La fuente trae `account_id` y `account_name` (Stripe: varias cuentas por holding). */
	hasAccount?: boolean;
	/** El proceso de importación acepta ids (si no, solo `all`). */
	importByIds: boolean;
	importable: boolean;
	/**
	 * Campos calculados con nombre legible para las reglas de exclusión (p. ej. "Correo del dueño", "Cantidad de ítems"). La fuente los
	 * agrega como claves de primer nivel de `rule_row`, así que las reglas los leen igual que una columna.
	 */
	computedFields?: ComputedRuleField[];
	/** La fuente trae `change_kind` (`new` | `update` | NULL), p. ej. con `stagingChangeKindSql`. */
	hasChangeKind?: boolean;
	/** La fuente trae `sapira_label`: nombre legible del registro de Sapira (p. ej. "Factura 10091 · CTR-2026-81"). */
	hasSapiraLabel?: boolean;
	/** La fuente trae `detail_kind` y `detail_label`: subestado legible del registro (p. ej. `erp_draft` · "Borrador en el ERP"). */
	hasDetail?: boolean;
	/**
	 * La fuente trae `status_label` propio (NULL = el de su estado). P. ej. CRM › oportunidad con cotización protegida:
	 * "Cotización con contrato: no se actualiza".
	 */
	hasStatusLabel?: boolean;
}

export interface ComputedRuleField {
	field: string;
	label: string;
	/** `number`: se compara como texto (`is` "0"), el front puede ofrecer un input numérico. */
	type: 'text' | 'number';
	/** El valor calculado va en minúsculas: el valor de la regla se guarda en minúsculas (correos). */
	lowercase?: boolean;
}

export interface IntegrationRecord {
	id: string;
	object: string;
	object_label: string;
	label: string;
	sapira_id: string | null;
	external_id: string | null;
	status: RecordStatus;
	status_label: string;
	/** `new` = se crea en Sapira, `update` = cambios a un registro existente, `null` = el adaptador no lo distingue. */
	change_kind: RecordChangeKind | null;
	/** Nombre legible del registro de Sapira (`sapira_id` sigue siendo el enlace). `null` si el adaptador no lo calcula. */
	sapira_label: string | null;
	/** Subestado del registro, propio del objeto (ERP › factura enviada: `erp_draft`, `scheduled`…). `null` si no aplica. */
	detail_kind: string | null;
	/** Etiqueta del subestado ("Borrador en el ERP", "Por enviar"…); el texto para la persona va en `message`. */
	detail_label: string | null;
	excluded_rule: string | null;
	account: { id: string; name: string | null } | null;
	message: string | null;
	last_sync_at: string | Date | null;
	/** Solo con `status = error`: el mismo error en varias corridas de los últimos 30 días (`null` = primera vez o sin historial). */
	recurrence: ErrorRecurrence | null;
}

/** Diferencia de un campo entre lo que llegó de la integración y lo que hay en Sapira (`GET records/:object/:key/changes`). */
export interface RecordFieldChange {
	/** Clave estable: `<destino>.<campo>` (p. ej. `client.industry`, `client_entity.legal_name`). */
	field: string;
	label: string;
	target: string;
	target_label: string;
	current: unknown;
	incoming: unknown;
	/** Importar aplica el valor que llegó (false: se conserva el actual). */
	applies: boolean;
}

export interface RecordChanges {
	object: string;
	record_key: string;
	label: string | null;
	change_kind: RecordChangeKind | null;
	sapira_id: string | null;
	sapira_label: string | null;
	/** El adaptador sabe calcular las diferencias de este objeto. */
	available: boolean;
	changes: RecordFieldChange[];
	message: string | null;
}

// ── Corridas (historial, D8) ────────────────────────────────────────────────────────────────────────────────────────────────

/** `interrupted` "Interrumpida": quedó en curso pero su proceso ya no existe (la API se reinició) o superó el tiempo máximo. */
export type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export const INTERRUPTED_MESSAGE = 'La sincronización se interrumpió (la API se reinició). Vuelve a sincronizar.';
/** Arranque de este proceso: un trabajo en curso de este entorno iniciado antes quedó huérfano (su proceso ya no existe). */
export const PROCESS_STARTED_AT = new Date();

/**
 * Un trabajo marcado "en curso" que ya no corre (sin escribir en la base, se decide al leer): superó el `leaseMs` o es de este mismo
 * entorno y empezó antes de que arrancara este proceso (la API se reinició a mitad: `nest --watch` o un deploy). Supone una instancia
 * por entorno, igual que los crons. Sin `environment` (el trabajo no lo guarda) solo cuenta el lease.
 */
export function isInterruptedJob(
	job: { startedAt?: Date | string | null; environment?: string | null },
	options: { leaseMs: number; environment?: string; now?: number; processStartedAt?: Date }
): boolean {
	const started = job.startedAt ? new Date(job.startedAt).getTime() : 0;

	if (!started || (options.now ?? Date.now()) - started > options.leaseMs) return true;

	return (
		options.environment !== undefined &&
		job.environment === options.environment &&
		started < (options.processStartedAt ?? PROCESS_STARTED_AT).getTime()
	);
}
export type RunTrigger = 'automatic' | 'manual';

export interface IntegrationRun {
	id: string;
	tipo: IntegrationTipo;
	kind: string;
	kind_label: string;
	trigger: RunTrigger;
	status: RunStatus;
	started_at: Date | string | null;
	finished_at: Date | string | null;
	duration_ms: number | null;
	totals: RunTotals;
	error: string | null;
	metrics: Record<string, unknown>;
	/** Errores que no estaban en la corrida anterior del mismo `kind` (lo agrega el servicio en `GET …/runs`). */
	errors_new?: number;
	/** Errores que ya estaban en la corrida anterior del mismo `kind`. */
	errors_recurring?: number;
	/** Primera aparición del error repetido más antiguo de la corrida (`null` sin repetidos). */
	errors_recurring_since?: string | null;
}

export interface RunRecord {
	object: string;
	/** Clave del registro, la misma `record_key` de `GET …/records` (CRM: id de la oportunidad, ERP: id de la factura). `null` si no hay. */
	record_key?: string | null;
	label: string;
	sapira_id: string | null;
	external_id: string | null;
	status: 'ok' | 'error' | 'skipped';
	message: string | null;
	/** Solo errores: el mismo error para el mismo registro en corridas anteriores (`null` = primera vez). Lo agrega el servicio. */
	recurrence?: ErrorRecurrence | null;
}

export interface ErrorSummaryItem {
	message: string;
	count: number;
	/** Agregado de los registros del grupo (lo agrega el servicio): `null` si ninguno se repite. */
	recurrence?: (ErrorRecurrence & { recurring_records: number }) | null;
}

export interface IntegrationRunDetail extends IntegrationRun {
	records: RunRecord[];
	errors_summary: ErrorSummaryItem[];
}

// ── Errores que se repiten ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Ventana en la que se buscan repeticiones de un error. */
export const RECURRENCE_WINDOW_DAYS = 30;

/**
 * Un error que se repite: el mismo registro (objeto + `record_key`) con el mismo mensaje normalizado en varias corridas de los últimos
 * `RECURRENCE_WINDOW_DAYS` días. Se informa solo desde la segunda corrida (`runs_count >= 2`).
 */
export interface ErrorRecurrence {
	/** Primera corrida de la ventana con este error. */
	first_seen_at: string;
	/** Corridas (incluida la de referencia) con este error para este registro. */
	runs_count: number;
	/** Ninguna corrida intermedia procesó el registro sin este error (ni bien ni con otro error). */
	consecutive: boolean;
}

/** Un registro dentro de una corrida, para calcular repeticiones (`IntegrationAdapter.recordHistory`). */
export interface RunOccurrence {
	run_id: string;
	kind: string;
	/** Cuándo se procesó (o el inicio de la corrida). */
	at: Date | string | null;
	object: string;
	record_key: string | null;
	status: 'ok' | 'error' | 'skipped';
	message: string | null;
}

export interface RecordHistoryOptions {
	since: Date;
	until?: Date;
	/** Solo estos `record_key` (de cualquier objeto). */
	keys?: string[];
	/** Solo las ocurrencias con error. */
	errorsOnly?: boolean;
}

/**
 * Mensaje comparable entre corridas: minúsculas, sin tildes, sin ids variables (uuids, ids del CRM, de Stripe, de Mongo: tokens de 8+
 * caracteres con algún dígito), sin fechas ni números y con los espacios colapsados.
 */
export function normalizeErrorMessage(message: string | null | undefined): string {
	return String(message ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?/g, '#')
		.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '#')
		.replace(/\b(?=[a-z0-9_-]*\d)[a-z0-9_-]{8,}\b/g, '#')
		.replace(/\d+(?:[.,]\d+)*/g, '#')
		.replace(/\s+/g, ' ')
		.trim();
}

const recordId = (object: string, recordKey: string | null | undefined) => `${object}\u0000${recordKey ?? ''}`;
const errorId = (object: string, recordKey: string | null | undefined, message: string | null | undefined) =>
	`${recordId(object, recordKey)}\u0000${normalizeErrorMessage(message)}`;
const timeOf = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : 0);
const isoOf = (value: number) => new Date(value).toISOString();

/**
 * Repetición de un error de un registro hasta `until` (inclusive) según el historial: corridas distintas con el mismo mensaje normalizado.
 * `null` si es la primera vez (o no hay historial).
 */
export function errorRecurrence(
	history: RunOccurrence[],
	ref: { object: string; record_key: string | null | undefined; message: string | null },
	until: Date | string | null = null
): ErrorRecurrence | null {
	const limit = until ? timeOf(until) : Number.POSITIVE_INFINITY;
	const target = normalizeErrorMessage(ref.message);
	const id = recordId(ref.object, ref.record_key);
	const own = history.filter((item) => recordId(item.object, item.record_key) === id && timeOf(item.at) <= limit);
	const matches = own.filter((item) => item.status === 'error' && normalizeErrorMessage(item.message) === target);
	const runs = new Set(matches.map((item) => item.run_id));

	if (runs.size < 2) return null;
	const first = Math.min(...matches.map((item) => timeOf(item.at)));
	const broken = own.some((item) => !runs.has(item.run_id) && timeOf(item.at) >= first);

	return { first_seen_at: isoOf(first), runs_count: runs.size, consecutive: !broken };
}

/** Repetición del error actual de un registro (lista de registros): el mensaje del registro o, si no aparece, el último error visto. */
export function currentErrorRecurrence(
	history: RunOccurrence[],
	record: { object: string; record_key: string; message: string | null }
): ErrorRecurrence | null {
	const direct = errorRecurrence(history, record);

	if (direct) return direct;
	const id = recordId(record.object, record.record_key);
	const latest = history.filter((item) => recordId(item.object, item.record_key) === id).sort((a, b) => timeOf(b.at) - timeOf(a.at))[0];

	return latest?.status === 'error' ? errorRecurrence(history, { ...record, message: latest.message }) : null;
}

/** Agrega la repetición a los errores de una corrida y a sus grupos de "Qué falló". */
export function withRecurrence(
	detail: IntegrationRunDetail,
	history: RunOccurrence[]
): IntegrationRunDetail & { records: Array<RunRecord & { recurrence: ErrorRecurrence | null }> } {
	// La corrida misma cuenta como ocurrencia aunque el adaptador no la devuelva en el historial.
	const own: RunOccurrence[] = detail.records.map((record) => ({
		run_id: detail.id,
		kind: detail.kind,
		at: detail.started_at,
		object: record.object,
		record_key: record.record_key ?? null,
		status: record.status,
		message: record.message,
	}));
	const all = [...history.filter((item) => item.run_id !== detail.id), ...own];
	const until = detail.started_at ? isoOf(Math.max(timeOf(detail.started_at), ...own.map((item) => timeOf(item.at)))) : null;
	const records = detail.records.map((record) => ({
		...record,
		recurrence: record.status === 'error' ? errorRecurrence(all, { ...record, record_key: record.record_key ?? null }, until) : null,
	}));
	const summary = detail.errors_summary.map((group) => {
		const members = records.filter(
			(record) => record.status === 'error' && ((record.message ?? '').trim() || 'Error sin detalle') === group.message && record.recurrence
		);
		const recurrences = members.map((record) => record.recurrence as ErrorRecurrence);

		return {
			...group,
			recurrence: recurrences.length
				? {
						first_seen_at: isoOf(Math.min(...recurrences.map((item) => timeOf(item.first_seen_at)))),
						runs_count: Math.max(...recurrences.map((item) => item.runs_count)),
						consecutive: recurrences.every((item) => item.consecutive),
						recurring_records: recurrences.length,
					}
				: null,
		};
	});

	return { ...detail, records, errors_summary: summary };
}

/** Errores nuevos y repetidos de una corrida (lista del Historial). */
export interface RunErrorDelta {
	errors_new: number;
	errors_recurring: number;
	/** Primera aparición del error repetido más antiguo (`null` sin repetidos). */
	errors_recurring_since: string | null;
}

/**
 * `runs`: las corridas conocidas (sin filtrar), `history`: lo que procesaron (errores y, para los registros con error, también lo demás).
 * Un error es repetido si la vez anterior que se procesó el mismo registro (en cualquier corrida, en orden) tuvo el mismo error; una corrida
 * que no tocó el registro no corta la cadena, una que lo procesó bien o con otro error sí. `first_seen` se arrastra por la cadena.
 */
export function runErrorDeltas(runs: IntegrationRun[], history: RunOccurrence[]): Map<string, RunErrorDelta> {
	const byRun = new Map<string, RunOccurrence[]>();

	for (const item of history) byRun.set(item.run_id, [...(byRun.get(item.run_id) ?? []), item]);
	const starts = new Map<string, number>(runs.map((run) => [run.id, timeOf(run.started_at)]));

	// Corridas que aparecen en el historial pero no en la lista (otra ventana u otro origen) también mueven la cadena.
	for (const [runId, items] of byRun) if (!starts.has(runId)) starts.set(runId, Math.min(...items.map((item) => timeOf(item.at))));
	const errorsOf = new Map(runs.map((run) => [run.id, run.totals.errors]));
	const open = new Map<string, Map<string, number>>();
	const result = new Map<string, RunErrorDelta>();

	for (const [runId, start] of [...starts.entries()].sort((a, b) => a[1] - b[1])) {
		const processed = new Map<string, Map<string, number>>();

		for (const item of byRun.get(runId) ?? []) {
			const record = recordId(item.object, item.record_key);
			const errors = processed.get(record) ?? new Map<string, number>();

			processed.set(record, errors);
			if (item.status === 'error') {
				const key = errorId(item.object, item.record_key, item.message);

				errors.set(key, Math.min(errors.get(key) ?? (timeOf(item.at) || start), timeOf(item.at) || start));
			}
		}
		let recurring = 0;
		let since: number | null = null;

		for (const [record, errors] of processed) {
			const previous = open.get(record);
			const next = new Map<string, number>();

			for (const [key, at] of errors) {
				const first = previous?.get(key);

				if (first !== undefined) {
					recurring++;
					since = since === null ? first : Math.min(since, first);
					next.set(key, first);
				} else next.set(key, at);
			}
			if (next.size) open.set(record, next);
			else open.delete(record);
		}
		if (errorsOf.has(runId)) {
			result.set(runId, {
				errors_new: Math.max(0, (errorsOf.get(runId) ?? 0) - recurring),
				errors_recurring: recurring,
				errors_recurring_since: since === null ? null : isoOf(since),
			});
		}
	}

	return result;
}

export interface RunsQuery {
	page: number;
	limit: number;
	/** Uno o varios (`failed,partial`). */
	status?: RunStatus | RunStatus[];
	kind?: string;
	trigger?: RunTrigger;
	from?: string;
	to?: string;
}

/**
 * Conteos de una corrida (ajuste de Domi 03-10): `ok` = se creó o actualizó algo, `unchanged` = procesado bien sin nada que hacer
 * (omitido, ya existía, sin cambios), `errors` = falló. `skipped` = `unchanged` (nombre anterior, se mantiene por compatibilidad).
 */
export interface RunTotals {
	total: number;
	ok: number;
	unchanged: number;
	errors: number;
	skipped: number;
}

export const runTotals = (input: { ok: number; errors: number; unchanged?: number; total?: number }): RunTotals => {
	const ok = Math.max(0, input.ok || 0);
	const errors = Math.max(0, input.errors || 0);
	const unchanged = Math.max(0, input.unchanged ?? (input.total !== undefined ? input.total - ok - errors : 0));

	return { total: Math.max(input.total ?? 0, ok + errors + unchanged), ok, unchanged, errors, skipped: unchanged };
};

/**
 * Estado de una corrida (ajuste de Domi 03-10). Lo sin cambios cuenta como correcto:
 * - `completed` ("Correcta"): sin errores, aunque todo sea sin cambios.
 * - `partial` ("Con errores"): al menos un error y algo bien o sin cambios; también una corrida que se cortó (`aborted`) después de
 *   procesar registros.
 * - `failed` ("Falló"): la corrida no pudo ejecutarse o terminó por una excepción sin registros procesados (`aborted`), o todos los
 *   registros procesados fallaron (ninguno bien ni sin cambios).
 */
export function runStatusOf(input: {
	running?: boolean;
	/** Estaba en curso pero ya no corre (`isInterruptedJob`). */
	interrupted?: boolean;
	/** La corrida misma falló (excepción, conexión, timeout), no un registro. */
	failed?: boolean;
	cancelled?: boolean;
	ok: number;
	unchanged?: number;
	errors: number;
}): RunStatus {
	const fine = input.ok + (input.unchanged ?? 0);

	if (input.running) return input.interrupted ? 'interrupted' : 'running';
	if (input.cancelled) return 'cancelled';
	if (input.failed) return fine > 0 ? 'partial' : 'failed';
	if (input.errors > 0) return fine > 0 ? 'partial' : 'failed';

	return 'completed';
}

export const durationMs = (start: Date | string | null | undefined, end: Date | string | null | undefined): number | null =>
	start && end ? Math.max(0, new Date(end).getTime() - new Date(start).getTime()) : null;

/** Mensajes de error repetidos agrupados (más frecuentes primero). */
export function errorsSummary(records: Array<{ status: string; message: string | null }>): Array<{ message: string; count: number }> {
	const counts = new Map<string, number>();

	for (const record of records) {
		if (record.status !== 'error') continue;
		const message = (record.message ?? 'Error sin detalle').trim() || 'Error sin detalle';

		counts.set(message, (counts.get(message) ?? 0) + 1);
	}

	return [...counts.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

/** Filtros comunes sobre corridas ya armadas (las fuentes mezclan Mongo y Postgres). */
export function filterRuns(runs: IntegrationRun[], query: Pick<RunsQuery, 'status' | 'kind' | 'trigger' | 'from' | 'to'>): IntegrationRun[] {
	const fromTime = query.from ? new Date(`${query.from}T00:00:00.000Z`).getTime() : null;
	const toTime = query.to ? new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000 : null;
	const statuses = query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];

	return runs.filter((run) => {
		const started = run.started_at ? new Date(run.started_at).getTime() : 0;

		return (
			(!statuses.length || statuses.includes(run.status)) &&
			(!query.kind || run.kind === query.kind) &&
			(!query.trigger || run.trigger === query.trigger) &&
			(fromTime === null || started >= fromTime) &&
			(toTime === null || started < toTime)
		);
	});
}

export const sortRunsDesc = (runs: IntegrationRun[]) =>
	[...runs].sort((a, b) => new Date(b.started_at ?? 0).getTime() - new Date(a.started_at ?? 0).getTime());

/** Id de corrida `<origen>:<id>` (el id puede traer `:`). */
export function parseRunId(id: string): { source: string; raw: string } | null {
	const index = id.indexOf(':');

	if (index <= 0 || index === id.length - 1) return null;

	return { source: id.slice(0, index), raw: id.slice(index + 1) };
}

// ── Paginado ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Paginated<T> {
	data: T[];
	total: number;
	currentPage: number;
	pages: number;
	limit: number;
}

export const paginated = <T>(data: T[], total: number, page: number, limit: number): Paginated<T> => ({
	data,
	total,
	currentPage: page,
	pages: Math.max(1, Math.ceil(total / limit)),
	limit,
});

export const paginateArray = <T>(items: T[], page: number, limit: number): Paginated<T> =>
	paginated(items.slice((page - 1) * limit, page * limit), items.length, page, limit);

// ── Mapeos (A2) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Ref {
	id: string;
	label: string;
	meta: Record<string, unknown>;
}

/**
 * `unused` "Sin uso": elemento de Sapira que hoy no se usa en lo que se envía (p. ej. compañía sin facturas ni contratos activos); estado
 * neutro, no cuenta como pendiente. `not_applicable` "No aplica": marcado a mano (§5.6); se oculta salvo con `status=not_applicable`.
 */
export const MAPPING_STATUSES = ['mapped', 'unmapped', 'suggested', 'unused', 'not_applicable'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export interface MappingRow {
	key: string;
	sapira: Ref | null;
	external: Ref | null;
	status: MappingStatus;
	suggestion: Ref | null;
	usage: Record<string, number> | null;
	meta: Record<string, unknown> | null;
}

export interface MappingView {
	object: string;
	object_label: string;
	anchor: 'sapira' | 'external';
	external_available: boolean;
	external_error: string | null;
	/** `total` = filas visibles por defecto (sin `not_applicable`) = mapped + unmapped + suggested + unused. */
	counts: { total: number; mapped: number; unmapped: number; suggested: number; unused: number; not_applicable: number };
	data: MappingRow[];
}

export interface MappingItem {
	sapira_id: string;
	external_id: string;
	meta?: Record<string, unknown>;
}

/** Texto comparable: sin mayúsculas, tildes ni signos. */
export const normalizeText = (value: unknown): string =>
	String(value ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

/** Sugerencia por código o nombre (normalizados). */
export function suggestRef(target: { label: string; code?: unknown }, candidates: Ref[]): Ref | null {
	const code = normalizeText(target.code);
	const label = normalizeText(target.label);

	if (code) {
		const byCode = candidates.find((candidate) => normalizeText(candidate.meta.code) === code);

		if (byCode) return byCode;
	}
	if (!label) return null;

	return candidates.find((candidate) => normalizeText(candidate.label) === label) ?? null;
}

/** Filtro y conteos comunes de una vista de mapeo. */
export function buildMappingView(
	base: Omit<MappingView, 'counts' | 'data'>,
	rows: MappingRow[],
	query: { status?: MappingStatus; search?: string }
): MappingView {
	const count = (status: MappingStatus) => rows.filter((row) => row.status === status).length;
	const counts = {
		total: rows.length - count('not_applicable'),
		mapped: count('mapped'),
		unmapped: count('unmapped'),
		suggested: count('suggested'),
		unused: count('unused'),
		not_applicable: count('not_applicable'),
	};
	const search = normalizeText(query.search);
	const data = rows.filter(
		(row) =>
			(query.status ? row.status === query.status : row.status !== 'not_applicable') &&
			(!search ||
				[row.sapira?.label, row.sapira?.id, row.external?.label, row.external?.id].some((value) => normalizeText(value).includes(search)))
	);

	return { ...base, counts, data };
}

/**
 * "No aplica" (§5.6): las filas cuya `key` está marcada pasan a `not_applicable` (sin sugerencia), salvo las mapeadas (un mapeo vigente
 * manda). Se aplica antes de `buildMappingView`.
 */
export function applyNotApplicable(rows: MappingRow[], keys: Iterable<string>): MappingRow[] {
	const marked = new Set(keys);

	return marked.size
		? rows.map((row) => (marked.has(row.key) && row.status !== 'mapped' ? { ...row, status: 'not_applicable' as const, suggestion: null } : row))
		: rows;
}

export const filterRefs = (refs: Ref[], search?: string): Ref[] => {
	const needle = normalizeText(search);

	return needle ? refs.filter((ref) => normalizeText(ref.label).includes(needle) || normalizeText(ref.id).includes(needle)) : refs;
};

// ── Conexión ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SecretInfo {
	has_secret: boolean;
	secret_last4: string | null;
}

export const secretInfo = (value: string | null | undefined): SecretInfo => {
	const text = (value ?? '').trim();

	return { has_secret: text.length > 0, secret_last4: text.length >= 8 ? text.slice(-4) : null };
};

export interface ConnectionView {
	tipo: IntegrationTipo;
	system: string | null;
	connected: boolean;
	id: string | null;
	name: string | null;
	active: boolean;
	fields: Record<string, unknown>;
	secrets: Record<string, SecretInfo>;
	last_sync_at: Date | string | null;
	created_at: Date | string | null;
	updated_at: Date | string | null;
}

export const emptyConnection = (tipo: IntegrationTipo): ConnectionView => ({
	tipo,
	system: null,
	connected: false,
	id: null,
	name: null,
	active: false,
	fields: {},
	secrets: {},
	last_sync_at: null,
	created_at: null,
	updated_at: null,
});

export interface ConnectionTestResult {
	ok: boolean;
	tested_at: string;
	message: string;
	details: Record<string, unknown>;
}

export interface SyncStarted {
	run_id: string | null;
	status: 'running' | 'completed';
	message: string;
}

export interface ImportStarted extends SyncStarted {
	accepted: number;
}

export interface ImportRequest {
	object: string;
	ids?: string[];
	all?: boolean;
	period?: string;
	/**
	 * CRM › oportunidades: confirma aplicar los cambios del CRM a cotizaciones existentes (solo con `ids`, nunca con `all`). Las
	 * cotizaciones con contrato no se actualizan nunca.
	 */
	confirm_updates?: boolean;
}

/** Quién opera (de `RequirePermissionGuard`): `authId` para tablas con FK a `auth.users`, `userId` para `public.users`. */
export interface Actor {
	authId: string;
	userId: string | null;
}

// ── Programación ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Próxima ocurrencia diaria a `hour:minute` en la hora local del proceso (los crons de la API corren en hora del servidor). */
export function nextDailyAt(hour: number, minute: number, now = new Date()): Date {
	const next = new Date(now);

	next.setHours(hour, minute, 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);

	return next;
}

/** Próxima ocurrencia diaria a `hour:minute` en una zona horaria IANA. */
export function nextDailyAtInZone(hour: number, minute: number, timeZone: string, now = new Date()): Date {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		})
			.formatToParts(now)
			.map((part) => [part.type, part.value])
	) as Record<string, string>;
	const zonedNow = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
	const offset = zonedNow - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes());
	let target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute) - offset;

	if (target <= now.getTime()) target += 86_400_000;

	return new Date(target);
}

export interface SummaryRow {
	tipo: IntegrationTipo;
	label: string;
	description: string;
	system: string | null;
	system_label: string | null;
	available_systems: Array<{ key: string; label: string }>;
	connected: boolean;
	active: boolean;
	direction: 'import' | 'export' | 'both';
	direction_label: string;
	last_sync_at: Date | string | null;
	last_sync_status: RunStatus | null;
	last_error: { message: string; at: Date | string | null } | null;
	/** Obsoleto: registros con error dentro de las corridas de los últimos 7 días (no es el KPI "Con error"). */
	errors_7d: number;
	/** Corridas fallidas o parciales en los últimos 7 días ("N sincronizaciones con error" → Historial filtrado). */
	failed_runs_7d: number;
	pending_mapping: number;
	/** Desde qué día (`YYYY-MM-DD`) se cuentan los KPIs de registros: el mismo `from` por defecto del 360 (7 días). */
	records_from: string;
	/** Los cuatro KPIs de `GET …/records?from=<records_from>` (mismas exclusiones: descartados y reglas). */
	records_kpis: { synced: number; error: number; review: number; ready: number; ready_new: number; ready_update: number };
	/** = `records_kpis.error`. */
	records_with_error: number;
	/** De los registros con error (`records_kpis.error`), cuántos tienen el mismo error en más de una corrida ("1 error que se repite"). */
	recurring_errors: number;
	/** Desde cuándo se repite el más antiguo de esos errores (`null` sin repetidos). */
	recurring_since: string | null;
	/** = `records_kpis.ready` ("Listos para importar" del 360). */
	pending_import: number;
	next_scheduled_at: string | null;
	href: string | null;
	/** Solo Stripe: cuentas del holding. */
	accounts?: Array<{ id: string | null; name: string | null; active: boolean; mode: unknown }>;
}

// ── Reglas de exclusión (ajuste de Domi) ────────────────────────────────────────────────────────────────────────────────────

export const RULE_OPERATORS = ['is', 'is_not', 'contains', 'empty', 'not_empty'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** Operadores con etiqueta para el constructor de reglas ("Cantidad de ítems" es "0", "Correo del dueño" es "<correo>"). */
export const RULE_OPERATOR_OPTIONS: Array<{ value: RuleOperator; label: string; needs_value: boolean }> = [
	{ value: 'is', label: 'es', needs_value: true },
	{ value: 'is_not', label: 'no es', needs_value: true },
	{ value: 'contains', label: 'contiene', needs_value: true },
	{ value: 'empty', label: 'está vacío', needs_value: false },
	{ value: 'not_empty', label: 'no está vacío', needs_value: false },
];

/** Campo disponible para reglas (`GET /integrations/:tipo/rules/fields`). */
export interface RuleField {
	field: string;
	label: string;
	sample: string | null;
	type: 'text' | 'number';
	/** Calculado por la API (nombre legible) y no columna ni clave de `raw_data`. */
	computed: boolean;
}

export interface RuleCondition {
	field: string;
	operator: RuleOperator;
	value?: string | null;
}

export interface ExclusionRule {
	id: string;
	name: string;
	object: string;
	enabled: boolean;
	conditions: RuleCondition[];
}

/** `raw_data.Owner.Name` → `['raw_data','Owner','Name']` (ruta para `#>>`). */
export const fieldPath = (field: string): string[] => field.split('.').filter(Boolean);

/** Escapa `%`, `_` y `\\` para `ILIKE`. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Expresión SQL de una regla sobre `alias.rule_row` (todas las condiciones). Agrega sus parámetros a `params` (posicionales desde el
 * largo actual + 1) y devuelve la expresión.
 */
export function ruleConditionSql(alias: string, rule: Pick<ExclusionRule, 'conditions'>, params: unknown[]): string {
	return rule.conditions
		.map((condition) => {
			params.push(fieldPath(condition.field));
			const value = `(${alias}.rule_row #>> $${params.length}::text[])`;

			switch (condition.operator) {
				case 'empty':
					return `COALESCE(${value}, '') = ''`;
				case 'not_empty':
					return `COALESCE(${value}, '') <> ''`;
				case 'is':
					params.push(String(condition.value ?? ''));

					return `${value} = $${params.length}`;
				case 'is_not':
					params.push(String(condition.value ?? ''));

					return `${value} IS DISTINCT FROM $${params.length}`;
				case 'contains':
					params.push(`%${escapeLike(String(condition.value ?? ''))}%`);

					return `${value} ILIKE $${params.length}`;
			}
		})
		.map((sql) => `(${sql})`)
		.join(' AND ');
}

export interface ScheduleInfo {
	daily_at: string;
	timezone: string;
	enabled: boolean;
	window_days?: number;
	next_at: string | null;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? 'Error desconocido'));

/** Errores de impacto (409) en la forma `{ field, message }`. */
export type ImpactErrors = FieldError[];

/** Mes anterior a hoy (`YYYY-MM-DD`): rango por defecto de "Traer oportunidades" (ajuste 4). */
export function lastMonthRange(today = new Date()): { from: string; to: string } {
	const to = today.toISOString().slice(0, 10);
	const fromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, today.getUTCDate()));

	return { from: fromDate.toISOString().slice(0, 10), to };
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

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
	`/lab/integraciones/${tipo}${tab ? `?tab=${tab}` : ''}`;

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
	excluded_rule: string | null;
	account: { id: string; name: string | null } | null;
	message: string | null;
	last_sync_at: string | Date | null;
}

// ── Corridas (historial, D8) ────────────────────────────────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
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
	totals: { total: number; ok: number; errors: number; skipped: number };
	error: string | null;
	metrics: Record<string, unknown>;
}

export interface RunRecord {
	object: string;
	label: string;
	sapira_id: string | null;
	external_id: string | null;
	status: 'ok' | 'error' | 'skipped';
	message: string | null;
}

export interface IntegrationRunDetail extends IntegrationRun {
	records: RunRecord[];
	errors_summary: Array<{ message: string; count: number }>;
}

export interface RunsQuery {
	page: number;
	limit: number;
	status?: RunStatus;
	kind?: string;
	trigger?: RunTrigger;
	from?: string;
	to?: string;
}

/** Estado de una corrida a partir de sus conteos. */
export function runStatusOf(input: { running?: boolean; failed?: boolean; cancelled?: boolean; ok: number; errors: number }): RunStatus {
	if (input.running) return 'running';
	if (input.cancelled) return 'cancelled';
	if (input.failed) return 'failed';
	if (input.errors > 0) return input.ok > 0 ? 'partial' : 'failed';

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

	return runs.filter((run) => {
		const started = run.started_at ? new Date(run.started_at).getTime() : 0;

		return (
			(!query.status || run.status === query.status) &&
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

export type MappingStatus = 'mapped' | 'unmapped' | 'suggested';

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
	counts: { total: number; mapped: number; unmapped: number; suggested: number };
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
	const counts = {
		total: rows.length,
		mapped: rows.filter((row) => row.status === 'mapped').length,
		unmapped: rows.filter((row) => row.status === 'unmapped').length,
		suggested: rows.filter((row) => row.status === 'suggested').length,
	};
	const search = normalizeText(query.search);
	const data = rows.filter(
		(row) =>
			(!query.status || row.status === query.status) &&
			(!search ||
				[row.sapira?.label, row.sapira?.id, row.external?.label, row.external?.id].some((value) => normalizeText(value).includes(search)))
	);

	return { ...base, counts, data };
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
	records_kpis: { synced: number; error: number; review: number; ready: number };
	/** = `records_kpis.error`. */
	records_with_error: number;
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

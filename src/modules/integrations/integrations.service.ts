import { randomUUID } from 'crypto';

import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { FieldError, validationException } from '@/core/utils/validation-errors';
import { HoldingIntegration, HoldingIntegrationSettings } from '@/databases/postgresql/entities/base-tenancy/holding-integration-settings.entity';
import type { PermissionContext } from '@/guards/permissions.service';

import { CrmAdapter } from './adapters/crm.adapter';
import { DatosAdapter } from './adapters/datos.adapter';
import { ErpAdapter } from './adapters/erp.adapter';
import { IntegrationAdapter, IntegrationRules } from './adapters/integration-adapter';
import { StripeAdapter } from './adapters/stripe.adapter';
import {
	Actor,
	daysBetween,
	DIRECTION_LABELS,
	escapeLike,
	ExclusionRule,
	ImportRequest,
	integrationHref,
	IntegrationRecord,
	isIntegrationTipo,
	lastMonthRange,
	MappingStatus,
	paginated,
	RECORD_STATUS_LABELS,
	RecordSource,
	RecordStatus,
	RULE_OPERATOR_OPTIONS,
	RULE_OPERATORS,
	ruleConditionSql,
	RuleField,
	SummaryRow,
	TIPO_INFO,
} from './integrations.types';

type Row = Record<string, unknown>;

/** Tipos con 360 (Stripe va completo y con varias cuentas: decisión de Domi 03-10). */
export const FULL_TIPOS = ['erp', 'crm', 'stripe', 'datos'] as const;
export type FullTipo = (typeof FULL_TIPOS)[number];

export const TECH_ADMIN_ROLE = 'Admin Técnico';

/**
 * Nombre de cada tipo en `holding_integration_settings` (tabla de Leon, ya en QA y producción), la **tabla única de ajustes por
 * integración**: `auto_enabled` (fila ausente = habilitado; apaga solo la corrida automática, el disparo manual sigue) y `settings` (reglas
 * del tipo y de exclusión) en la misma fila. `stripe` entra a su CHECK con `1791000000000-IntegrationsV2`.
 */
export const AUTO_SYNC_INTEGRATION: Record<FullTipo, HoldingIntegration> = { erp: 'odoo', crm: 'salesforce', datos: 'bigquery', stripe: 'stripe' };

export interface RecordsQuery {
	object?: string;
	/** Stripe: cuenta de origen. */
	account_id?: string;
	status?: string[];
	rule?: string;
	from?: string;
	to?: string;
	search?: string;
	page: number;
	limit: number;
}

const HIDDEN_STATUSES: RecordStatus[] = ['discarded', 'excluded_by_rule'];

/**
 * Integraciones v2 (`docs/v2-rediseno/contrato-api-integraciones.md`): resumen, reglas por tipo, estado de sincronización genérico (A2) sobre
 * las fuentes SQL de cada adaptador, descartes y reglas de exclusión, importar y sugerencias de mapeo. Lo propio de cada sistema vive en
 * su adaptador.
 */
@Injectable()
export class IntegrationsService {
	private readonly logger = new Logger(IntegrationsService.name);
	private readonly adapters: Record<FullTipo, IntegrationAdapter>;

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(HoldingIntegrationSettings) private readonly integrationSettings: Repository<HoldingIntegrationSettings>,
		readonly erp: ErpAdapter,
		readonly crm: CrmAdapter,
		readonly stripe: StripeAdapter,
		readonly datos: DatosAdapter
	) {
		this.adapters = { erp, crm, stripe, datos };
	}

	adapter(tipo: string): IntegrationAdapter {
		if (!(FULL_TIPOS as readonly string[]).includes(tipo)) throw new NotFoundException('Integración no encontrada');

		return this.adapters[tipo as FullTipo];
	}

	actorOf(authId: string, context?: PermissionContext): Actor {
		return { authId, userId: context?.userId ?? null };
	}

	/** Mapeo de campos (ajuste 1): cambiarlo exige super admin o el rol Admin Técnico del holding. */
	async assertFieldsEditor(holdingId: string, context?: PermissionContext): Promise<void> {
		if (context?.isSuperAdmin) return;
		if (context?.roleId) {
			const [role] = (await this.dataSource.query(`SELECT name FROM roles WHERE id = $1 AND holding_id = $2`, [
				context.roleId,
				holdingId,
			])) as Row[];

			if (role?.name === TECH_ADMIN_ROLE) return;
		}
		throw new ForbiddenException('Solo un super admin o el Administrador técnico pueden cambiar el mapeo de campos');
	}

	/** Eliminar una conexión: con impacto y sin `confirm` → 409 con el detalle (contrato §2.5). */
	async deleteConnection(holdingId: string, tipo: string, confirm: boolean, connectionId?: string): Promise<void> {
		const adapter = this.adapter(tipo);
		const impact = await adapter.deleteImpact(holdingId, connectionId);

		if (impact.length && !confirm) {
			throw new ConflictException({ message: `Eliminar la conexión afecta: ${impact.map((item) => item.message).join(', ')}`, errors: impact });
		}
		await adapter.deleteConnection(holdingId, connectionId);
	}

	// ── Resumen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async summaryOf(holdingId: string, tipo: FullTipo): Promise<SummaryRow> {
		const adapter = this.adapters[tipo];
		const info = TIPO_INFO[tipo];
		const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
		const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
			try {
				return await work();
			} catch (error) {
				this.logger.warn(`Resumen de ${tipo} incompleto (${holdingId}): ${(error as Error).message}`);

				return fallback;
			}
		};
		const [connection, last, recent, pendingMapping, records] = await Promise.all([
			adapter.getConnection(holdingId),
			safe(() => adapter.listRuns(holdingId, { page: 1, limit: 1 }), null),
			safe(() => adapter.listRuns(holdingId, { page: 1, limit: 100, from: sevenDaysAgo }), null),
			safe(() => adapter.pendingMapping(holdingId), 0),
			safe(() => this.records(holdingId, tipo, { page: 1, limit: 1 }), null),
		]);
		const lastRun = last?.data[0] ?? null;
		const lastError = recent?.data.find((run) => run.error || run.status === 'failed' || run.status === 'partial') ?? null;
		const schedule = adapter.schedule();

		return {
			tipo,
			label: info.label,
			description: info.description,
			system: connection.connected ? info.system : null,
			system_label: connection.connected ? info.system_label : null,
			available_systems: [{ key: info.system, label: info.system_label }],
			connected: connection.connected,
			active: connection.active,
			direction: info.direction,
			direction_label: DIRECTION_LABELS[info.direction],
			last_sync_at: lastRun?.finished_at ?? lastRun?.started_at ?? connection.last_sync_at,
			last_sync_status: lastRun?.status ?? null,
			last_error: lastError
				? {
						message: lastError.error ?? `${lastError.totals.errors} registros con error en ${lastError.kind_label.toLowerCase()}`,
						at: lastError.started_at,
					}
				: null,
			errors_7d: (recent?.data ?? []).reduce((sum, run) => sum + run.totals.errors, 0),
			pending_mapping: pendingMapping,
			pending_import: records?.kpis.ready ?? 0,
			next_scheduled_at: connection.connected && connection.active ? schedule.next_at : null,
			href: integrationHref(tipo),
			...(tipo === 'stripe'
				? {
						accounts: (await this.stripe.listConnections(holdingId)).data.map((account) => ({
							id: account.id,
							name: account.name,
							active: account.active,
							mode: account.fields.mode ?? null,
						})),
					}
				: {}),
		};
	}

	async summary(holdingId: string) {
		return { data: await Promise.all(FULL_TIPOS.map((tipo) => this.summaryOf(holdingId, tipo))) };
	}

	// ── Reglas por tipo (settings) y reglas de exclusión ───────────────────────────────────────────────────────────────────

	private settingsRow(holdingId: string, tipo: FullTipo): Promise<HoldingIntegrationSettings | null> {
		return this.integrationSettings.findOne({ where: { holding_id: holdingId, integration: AUTO_SYNC_INTEGRATION[tipo] } });
	}

	private async storedSettings(holdingId: string, tipo: FullTipo): Promise<Record<string, unknown>> {
		return (await this.settingsRow(holdingId, tipo))?.settings ?? {};
	}

	/** Upsert de la fila del holding: solo las columnas indicadas (una fila nueva nace con `auto_enabled = true`, el default). */
	private async writeRow(
		holdingId: string,
		tipo: FullTipo,
		values: Partial<Pick<HoldingIntegrationSettings, 'settings' | 'auto_enabled' | 'updated_by'>>
	) {
		await this.integrationSettings.upsert(
			{ holding_id: holdingId, integration: AUTO_SYNC_INTEGRATION[tipo], ...values, updated_at: new Date() },
			{ conflictPaths: ['holding_id', 'integration'], skipUpdateIfNoValuesChanged: false }
		);
	}

	private async writeSettings(holdingId: string, tipo: FullTipo, settings: Record<string, unknown>, actor: Actor) {
		await this.writeRow(holdingId, tipo, { settings, updated_by: actor.userId });
	}

	/** Reglas efectivas del tipo (defaults + guardadas), sin las de exclusión. */
	async effectiveRules(holdingId: string, tipo: FullTipo): Promise<IntegrationRules> {
		const stored = await this.storedSettings(holdingId, tipo);
		const defaults = this.adapters[tipo].defaultRules;

		return Object.fromEntries(Object.keys(defaults).map((key) => [key, stored[key] ?? defaults[key]]));
	}

	async getSettings(holdingId: string, tipo: string) {
		const adapter = this.adapter(tipo);
		const row = await this.settingsRow(holdingId, tipo as FullTipo);
		const stored = row?.settings ?? {};
		const defaults = adapter.defaultRules;

		return {
			tipo,
			/** Corrida automática habilitada para el holding (`holding_integration_settings.auto_enabled`; fila ausente = true). */
			auto_sync: row?.auto_enabled !== false,
			settings: Object.fromEntries(Object.keys(defaults).map((key) => [key, stored[key] ?? defaults[key]])),
			defaults,
			uses_default: Object.fromEntries(Object.keys(defaults).map((key) => [key, stored[key] === undefined || stored[key] === null])),
			schedule: adapter.schedule(),
		};
	}

	async putSettings(holdingId: string, tipo: string, input: Record<string, unknown>, actor: Actor) {
		const adapter = this.adapter(tipo);
		const allowed = Object.keys(adapter.defaultRules);
		const errors: FieldError[] = [];
		const { auto_sync: autoSync, ...rest } = input ?? {};

		input = rest;
		if (autoSync !== undefined) {
			if (typeof autoSync !== 'boolean') errors.push({ field: 'settings.auto_sync', message: 'Debe ser verdadero o falso' });
		}
		for (const [key, value] of Object.entries(input ?? {})) {
			if (!allowed.includes(key)) {
				errors.push({ field: `settings.${key}`, message: 'Regla no reconocida para esta integración' });
				continue;
			}
			if (value === null) continue;
			if (key === 'opportunity_stages') {
				const ok =
					Array.isArray(value) &&
					value.length >= 1 &&
					value.length <= 20 &&
					value.every((stage) => typeof stage === 'string' && stage.trim() !== '' && stage.length <= 80);

				if (!ok) errors.push({ field: 'settings.opportunity_stages', message: 'Indica entre 1 y 20 etapas (máximo 80 caracteres cada una)' });
			}
			if (key === 'exclude_sapira_invoices' && typeof value !== 'boolean') {
				errors.push({ field: 'settings.exclude_sapira_invoices', message: 'Debe ser verdadero o falso' });
			}
		}
		if (errors.length) throw validationException(errors);
		const stored = await this.storedSettings(holdingId, tipo as FullTipo);
		const next = { ...stored };

		for (const [key, value] of Object.entries(input ?? {})) {
			if (value === null) delete next[key];
			else next[key] = key === 'opportunity_stages' ? (value as string[]).map((stage) => stage.trim()) : value;
		}
		if (Object.keys(input).length || typeof autoSync === 'boolean') {
			await this.writeRow(holdingId, tipo as FullTipo, {
				...(Object.keys(input).length ? { settings: next } : {}),
				...(typeof autoSync === 'boolean' ? { auto_enabled: autoSync } : {}),
				updated_by: actor.userId,
			});
		}

		return this.getSettings(holdingId, tipo);
	}

	private async storedRules(holdingId: string, tipo: FullTipo): Promise<ExclusionRule[]> {
		const rules = (await this.storedSettings(holdingId, tipo)).rules;

		return Array.isArray(rules) ? (rules as ExclusionRule[]) : [];
	}

	private sourceOf(tipo: FullTipo, object: string, rules?: IntegrationRules): RecordSource {
		const source = this.adapters[tipo].recordSources(rules ?? this.adapters[tipo].defaultRules).find((item) => item.object === object);

		if (!source) throw validationException([{ field: 'object', message: `Objeto no válido: ${object}` }]);

		return source;
	}

	/**
	 * Campos disponibles para reglas: primero los calculados con nombre legible de la fuente (CRM: correo y nombre del dueño, cantidad de
	 * ítems, etapa, tipo, forma de pago), después las columnas de la tabla intermedia y las claves de `raw_data` (dos niveles, muestra de 200).
	 */
	async ruleFields(holdingId: string, tipo: string, object: string) {
		this.adapter(tipo);
		const source = this.sourceOf(tipo as FullTipo, object);
		const columns = (await this.dataSource.query(
			`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
			[source.table]
		)) as Row[];
		const fields: RuleField[] = [];
		const computed = source.computedFields ?? [];

		if (computed.length) {
			const [samples] = (await this.dataSource.query(
				`SELECT ${computed.map((item, index) => `min(x.rule_row->>'${item.field}') AS c${index}`).join(', ')} FROM (${source.sql}) x`,
				[holdingId]
			)) as Row[];

			fields.push(
				...computed.map((item, index) => ({
					field: item.field,
					label: item.label,
					sample: (samples?.[`c${index}`] as string) ?? null,
					type: item.type,
					computed: true,
				}))
			);
		}
		fields.push(
			...columns
				.filter((column) => !['jsonb', 'json'].includes(String(column.data_type)))
				.map((column) => ({
					field: String(column.column_name),
					label: String(column.column_name),
					sample: null,
					type: 'text' as const,
					computed: false,
				}))
		);

		if (columns.some((column) => column.column_name === 'raw_data')) {
			const keys = (await this.dataSource.query(
				`WITH sample AS (SELECT raw_data FROM ${source.table} WHERE holding_id = $1 AND raw_data IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 200),
				top AS (SELECT k1.key, k1.value FROM sample, jsonb_each(sample.raw_data) k1)
				SELECT 'raw_data.' || key AS field, min(value #>> '{}') FILTER (WHERE jsonb_typeof(value) NOT IN ('object','array','null')) AS sample
					FROM top WHERE jsonb_typeof(value) <> 'object' GROUP BY key
				UNION ALL
				SELECT 'raw_data.' || top.key || '.' || k2.key, min(k2.value #>> '{}') FILTER (WHERE jsonb_typeof(k2.value) NOT IN ('object','array','null'))
					FROM top, jsonb_each(top.value) k2 WHERE jsonb_typeof(top.value) = 'object' AND jsonb_typeof(k2.value) <> 'object' GROUP BY top.key, k2.key
				ORDER BY 1`,
				[holdingId]
			)) as Row[];

			fields.push(
				...keys.map((key) => ({
					field: String(key.field),
					label: String(key.field).replace(/^raw_data\./, ''),
					sample: (key.sample as string) ?? null,
					type: 'text' as const,
					computed: false,
				}))
			);
		}

		return { object, operators: RULE_OPERATOR_OPTIONS, data: fields };
	}

	async getRules(holdingId: string, tipo: string) {
		this.adapter(tipo);
		const rules = await this.storedRules(holdingId, tipo as FullTipo);
		const counts = rules.length ? (await this.records(holdingId, tipo, { page: 1, limit: 1 })).rules : [];

		return { data: rules.map((rule) => ({ ...rule, matches: counts.find((count) => count.id === rule.id)?.count ?? 0 })) };
	}

	async putRules(
		holdingId: string,
		tipo: string,
		rules: Array<Omit<ExclusionRule, 'id' | 'enabled'> & { id?: string; enabled?: boolean }>,
		actor: Actor
	) {
		this.adapter(tipo);
		const errors: FieldError[] = [];
		const fieldsByObject = new Map<string, Set<string>>();
		const lowercaseFields = (object: string) =>
			new Set(
				(
					this.adapters[tipo as FullTipo].recordSources(this.adapters[tipo as FullTipo].defaultRules).find((item) => item.object === object)
						?.computedFields ?? []
				)
					.filter((item) => item.lowercase)
					.map((item) => item.field)
			);

		for (const [index, rule] of rules.entries()) {
			let fields = fieldsByObject.get(rule.object);

			if (!fields) {
				try {
					fields = new Set((await this.ruleFields(holdingId, tipo, rule.object)).data.map((field) => field.field));
				} catch {
					errors.push({ field: `rules.${index}.object`, message: `Objeto no válido: ${rule.object}` });
					continue;
				}
				fieldsByObject.set(rule.object, fields);
			}
			for (const [position, condition] of rule.conditions.entries()) {
				const base = `rules.${index}.conditions.${position}`;

				if (!fields.has(condition.field) && !condition.field.startsWith('raw_data.'))
					errors.push({ field: `${base}.field`, message: `Campo no disponible: ${condition.field}` });
				if (!(RULE_OPERATORS as readonly string[]).includes(condition.operator))
					errors.push({ field: `${base}.operator`, message: 'Operador no válido' });
				if (
					['is', 'is_not', 'contains'].includes(condition.operator) &&
					(condition.value === undefined || condition.value === null || condition.value === '')
				) {
					errors.push({ field: `${base}.value`, message: 'Falta el valor' });
				}
			}
		}
		if (errors.length) throw validationException(errors);
		const stored = await this.storedSettings(holdingId, tipo as FullTipo);

		await this.writeSettings(
			holdingId,
			tipo as FullTipo,
			{
				...stored,
				rules: rules.map((rule) => ({
					id: rule.id ?? randomUUID(),
					name: rule.name.trim(),
					object: rule.object,
					enabled: rule.enabled !== false,
					conditions: rule.conditions.map((condition) => ({
						field: condition.field,
						operator: condition.operator,
						...(['empty', 'not_empty'].includes(condition.operator)
							? {}
							: {
									value: lowercaseFields(rule.object).has(condition.field)
										? String(condition.value).trim().toLowerCase()
										: String(condition.value),
								}),
					})),
				})),
			},
			actor
		);

		return this.getRules(holdingId, tipo);
	}

	// ── Estado de sincronización (registros) ────────────────────────────────────────────────────────────────────────────────

	/** CTE común: fuentes del tipo → regla que excluye → descarte → estado final, con los filtros base (objeto, fechas, búsqueda). */
	private async recordsCte(holdingId: string, tipo: FullTipo, query: Pick<RecordsQuery, 'object' | 'from' | 'to' | 'search' | 'account_id'>) {
		const settings = await this.effectiveRules(holdingId, tipo);
		const sources = this.adapters[tipo].recordSources(settings).filter((source) => !query.object || source.object === query.object);

		if (query.object && !sources.length) throw validationException([{ field: 'object', message: `Objeto no válido: ${query.object}` }]);
		const rules = (await this.storedRules(holdingId, tipo)).filter((rule) => rule.enabled !== false && rule.conditions?.length);
		const params: unknown[] = [holdingId, tipo];
		const ruleCases = rules
			.filter((rule) => sources.some((source) => source.object === rule.object))
			.map((rule) => {
				params.push(rule.object);
				const objectParam = params.length;
				const condition = ruleConditionSql('r', rule, params);

				params.push(rule.id);

				return `WHEN r.object = $${objectParam} AND ${condition} THEN $${params.length}`;
			});
		const filters: string[] = [];

		if (query.from) {
			params.push(query.from);
			filters.push(`f.last_sync_at >= $${params.length}::date`);
		}
		if (query.to) {
			params.push(query.to);
			filters.push(`f.last_sync_at < ($${params.length}::date + 1)`);
		}
		if (query.account_id) {
			params.push(query.account_id);
			filters.push(`f.account_id = $${params.length}`);
		}
		if (query.search?.trim()) {
			params.push(`%${escapeLike(query.search.trim())}%`);
			filters.push(`(f.label ILIKE $${params.length} OR f.external_id ILIKE $${params.length} OR f.sapira_id ILIKE $${params.length})`);
		}
		const union = sources
			.map(
				(source) =>
					`SELECT '${source.object}'::text AS object, x.record_key, x.label, x.sapira_id, x.external_id, x.status, x.message, x.last_sync_at, x.rule_row, ${
						source.hasAccount ? 'x.account_id, x.account_name' : 'NULL::text AS account_id, NULL::text AS account_name'
					} FROM (${source.sql}) x`
			)
			.join('\nUNION ALL\n');
		const sql = `WITH r AS (${union}),
			e AS (SELECT r.*, ${ruleCases.length ? `CASE ${ruleCases.join(' ')} END` : 'NULL::text'} AS excluded_rule FROM r),
			f AS (SELECT e.object, e.record_key, e.label, e.sapira_id, e.external_id, e.status AS source_status, e.message, e.last_sync_at, e.excluded_rule,
				e.account_id, e.account_name,
				CASE WHEN d.id IS NOT NULL THEN 'discarded' WHEN e.excluded_rule IS NOT NULL THEN 'excluded_by_rule' ELSE e.status END AS status
				FROM e LEFT JOIN integration_record_discards d ON d.holding_id = $1 AND d.tipo = $2 AND d.object = e.object AND d.record_key = e.record_key),
			g AS (SELECT * FROM f ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''})`;

		return { sql, params, sources, rules };
	}

	async records(holdingId: string, tipo: string, query: RecordsQuery) {
		this.adapter(tipo);
		const { sql, params, sources, rules } = await this.recordsCte(holdingId, tipo as FullTipo, query);
		const statusParams = [...params];
		let statusFilter = `g.status <> ALL($${statusParams.push(HIDDEN_STATUSES)}::text[])`;

		if (query.status?.length) statusFilter = `g.status = ANY($${statusParams.push(query.status)}::text[])`;
		if (query.rule) {
			const rule = rules.find((item) => item.name === query.rule || item.id === query.rule);

			statusFilter += ` AND g.excluded_rule = $${statusParams.push(rule?.id ?? '__sin_regla__')}`;
		}
		const pageParams = [...statusParams, query.limit, (query.page - 1) * query.limit];
		const [statusCounts, objectCounts, ruleCounts, [{ total }], rows] = await Promise.all([
			this.dataSource.query(`${sql} SELECT status, count(*)::int AS n FROM g GROUP BY status`, params) as Promise<Row[]>,
			this.dataSource.query(
				`${sql} SELECT object, count(*)::int AS n FROM g WHERE g.status <> ALL($${params.length + 1}::text[]) GROUP BY object`,
				[...params, HIDDEN_STATUSES]
			) as Promise<Row[]>,
			this.dataSource.query(
				`${sql} SELECT excluded_rule, count(*)::int AS n FROM g WHERE g.status = 'excluded_by_rule' GROUP BY excluded_rule`,
				params
			) as Promise<Row[]>,
			this.dataSource.query(`${sql} SELECT count(*)::int AS total FROM g WHERE ${statusFilter}`, statusParams) as Promise<Row[]>,
			this.dataSource.query(
				`${sql} SELECT * FROM g WHERE ${statusFilter}
				ORDER BY CASE g.status WHEN 'error' THEN 0 WHEN 'ready' THEN 1 WHEN 'pending' THEN 2 WHEN 'synced' THEN 3 WHEN 'imported' THEN 4
					WHEN 'excluded_by_rule' THEN 5 ELSE 6 END, g.last_sync_at DESC NULLS LAST, g.record_key
				LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
				pageParams
			) as Promise<Row[]>,
		]);
		const count = (status: string) => Number(statusCounts.find((row) => row.status === status)?.n ?? 0);
		const labels = new Map(sources.map((source) => [source.object, source.label]));
		const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
		const data: IntegrationRecord[] = rows.map((row) => ({
			id: `${row.object}:${row.record_key}`,
			object: String(row.object),
			object_label: labels.get(String(row.object)) ?? String(row.object),
			label: String(row.label ?? row.external_id ?? row.record_key ?? ''),
			sapira_id: (row.sapira_id as string) ?? null,
			external_id: (row.external_id as string) ?? null,
			status: row.status as RecordStatus,
			status_label: RECORD_STATUS_LABELS[row.status as RecordStatus] ?? String(row.status),
			excluded_rule: row.excluded_rule ? (ruleById.get(String(row.excluded_rule))?.name ?? null) : null,
			account: row.account_id ? { id: String(row.account_id), name: (row.account_name as string) ?? null } : null,
			message: (row.message as string) ?? null,
			last_sync_at: (row.last_sync_at as Date) ?? null,
		}));

		return {
			kpis: {
				synced: count('imported') + count('synced'),
				error: count('error'),
				pending: count('pending') + count('ready'),
				ready: count('ready'),
				discarded: count('discarded'),
				excluded_by_rule: count('excluded_by_rule'),
			},
			objects: sources.map((source) => ({
				key: source.object,
				label: source.label,
				direction: source.direction,
				importable: source.importable,
				import_by_ids: source.importByIds,
				count: Number(objectCounts.find((row) => row.object === source.object)?.n ?? 0),
			})),
			rules: ruleCounts.map((row) => ({
				id: String(row.excluded_rule),
				name: ruleById.get(String(row.excluded_rule))?.name ?? String(row.excluded_rule),
				count: Number(row.n) || 0,
			})),
			...paginated(data, Number(total) || 0, query.page, query.limit),
		};
	}

	/** Claves de un objeto en ciertos estados finales (descartados, excluidos) o existentes (`statuses` vacío). */
	private async recordKeys(holdingId: string, tipo: FullTipo, object: string, statuses: string[] | null, keys?: string[]): Promise<Set<string>> {
		const { sql, params } = await this.recordsCte(holdingId, tipo, { object });
		const where: string[] = [];
		const all = [...params];

		if (statuses) where.push(`g.status = ANY($${all.push(statuses)}::text[])`);
		if (keys) where.push(`g.record_key = ANY($${all.push(keys)}::text[])`);
		const rows = (await this.dataSource.query(
			`${sql} SELECT g.record_key FROM g ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
			all
		)) as Row[];

		return new Set(rows.map((row) => String(row.record_key)));
	}

	async discard(holdingId: string, tipo: string, body: { object: string; ids: string[]; reason?: string }, actor: Actor) {
		this.adapter(tipo);
		this.sourceOf(tipo as FullTipo, body.object);
		const existing = [...(await this.recordKeys(holdingId, tipo as FullTipo, body.object, null, body.ids))];

		if (!existing.length) return { updated: 0 };
		const rows = (await this.dataSource.query(
			`INSERT INTO integration_record_discards (holding_id, tipo, object, record_key, reason, discarded_by)
			SELECT $1, $2, $3, key, $5, $6 FROM unnest($4::text[]) AS key
			ON CONFLICT (holding_id, tipo, object, record_key) DO NOTHING RETURNING id`,
			[holdingId, tipo, body.object, existing, body.reason ?? null, actor.userId]
		)) as Row[];

		return { updated: rows.length };
	}

	async restore(holdingId: string, tipo: string, body: { object: string; ids: string[] }) {
		this.adapter(tipo);
		this.sourceOf(tipo as FullTipo, body.object);
		const result = (await this.dataSource.query(
			`DELETE FROM integration_record_discards WHERE holding_id = $1 AND tipo = $2 AND object = $3 AND record_key = ANY($4::text[]) RETURNING id`,
			[holdingId, tipo, body.object, body.ids]
		)) as unknown[];

		return { updated: Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length };
	}

	async importRecords(holdingId: string, tipo: string, request: ImportRequest, actor: Actor) {
		const adapter = this.adapter(tipo);
		const source = this.sourceOf(tipo as FullTipo, request.object);

		if (!source.importable) throw validationException([{ field: 'object', message: 'Este objeto no se importa' }]);
		if (!request.all && !request.ids?.length) throw validationException([{ field: 'ids', message: 'Indica los registros o all: true' }]);
		if (request.ids?.length && !source.importByIds) {
			throw validationException([{ field: 'ids', message: 'Este objeto se importa completo (usa all)' }]);
		}
		const skip = await this.recordKeys(holdingId, tipo as FullTipo, request.object, HIDDEN_STATUSES);

		return adapter.importRecords(holdingId, request, actor, skip);
	}

	// ── Mapeos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private assertMappingObject(adapter: IntegrationAdapter, object: string) {
		if (!adapter.mappingObjects.includes(object)) throw new NotFoundException('Mapeo no encontrado');
	}

	async getMapping(holdingId: string, tipo: string, object: string, query: { status?: MappingStatus; search?: string }) {
		const adapter = this.adapter(tipo);

		this.assertMappingObject(adapter, object);

		return adapter.getMapping(holdingId, object, query);
	}

	async mappingOptions(holdingId: string, tipo: string, object: string, side: 'sapira' | 'external', search?: string) {
		const adapter = this.adapter(tipo);

		this.assertMappingObject(adapter, object);

		return adapter.mappingOptions(holdingId, object, side, search);
	}

	async putMapping(
		holdingId: string,
		tipo: string,
		object: string,
		items: Array<{ sapira_id: string; external_id: string; meta?: Record<string, unknown> }>,
		actor: Actor
	) {
		const adapter = this.adapter(tipo);

		this.assertMappingObject(adapter, object);
		await adapter.putMapping(holdingId, object, items, actor);

		return adapter.getMapping(holdingId, object, {});
	}

	async deleteMapping(holdingId: string, tipo: string, object: string, sapiraId: string, externalId: string, confirm: boolean) {
		const adapter = this.adapter(tipo);

		this.assertMappingObject(adapter, object);
		await adapter.deleteMapping(holdingId, object, sapiraId, externalId, confirm);
	}

	/** Acepta las sugerencias deterministas (todas o las `keys` indicadas) con las reglas del PUT. */
	async acceptSuggestions(holdingId: string, tipo: string, object: string, keys: string[] | undefined, actor: Actor) {
		const adapter = this.adapter(tipo);

		this.assertMappingObject(adapter, object);
		if (object === 'fields') throw new BadRequestException('El mapeo de campos no tiene sugerencias');
		const view = await adapter.getMapping(holdingId, object, { status: 'suggested' });
		const rows = view.data.filter((row) => row.suggestion && (!keys?.length || keys.includes(row.key)));
		const items = rows
			.map((row) =>
				view.anchor === 'sapira'
					? { sapira_id: row.sapira?.id ?? '', external_id: row.suggestion?.id ?? '' }
					: { sapira_id: row.suggestion?.id ?? '', external_id: row.external?.id ?? '' }
			)
			.filter((item) => item.sapira_id && item.external_id);

		if (items.length) await adapter.putMapping(holdingId, object, items, actor);

		return { accepted: items.length, view: await adapter.getMapping(holdingId, object, {}) };
	}

	// ── CRM: traer oportunidades (A5) ───────────────────────────────────────────────────────────────────────────────────────

	async fetchCrmOpportunities(holdingId: string, body: { date_from?: string; date_to?: string; opportunity_ids?: string[] }) {
		const range = lastMonthRange();
		const from = body.date_from ?? (body.date_to ? body.date_to : range.from);
		const to = body.date_to ?? range.to;

		if (!body.opportunity_ids?.length) {
			if (from > to) throw validationException([{ field: 'date_from', message: 'La fecha inicial es posterior a la final' }]);
			if (daysBetween(from, to) > 366) throw validationException([{ field: 'date_to', message: 'El rango no puede superar un año' }]);
		}
		const stages = (await this.effectiveRules(holdingId, 'crm')).opportunity_stages as string[];

		return this.crm.fetchOpportunities(holdingId, { date_from: from, date_to: to, opportunity_ids: body.opportunity_ids, stages });
	}

	static isTipo = isIntegrationTipo;
}

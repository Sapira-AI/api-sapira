import { randomUUID } from 'crypto';

import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { SalesforceAccount } from '@/modules/salesforce/interfaces/salesforce.interface';
import { SalesforceService } from '@/modules/salesforce/salesforce.service';
import { SalesforceSchedulerJob, SalesforceSchedulerJobDocument } from '@/modules/salesforce/schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog, SalesforceSyncLogDocument } from '@/modules/salesforce/schemas/salesforce-sync-log.schema';
import { SalesforceSyncCompleteService } from '@/modules/salesforce/services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from '@/modules/salesforce/services/salesforce-sync-run.service';
import { isoToCountryName, normalizeTaxId } from '@/modules/salesforce/utils/salesforce-transformers';

import { errorText, paginated, Paginated } from '../integrations.types';

type Row = Record<string, unknown>;

/** Prefijo del trabajo que deja una importación de clientes en el historial de la integración (`crm-job:<jobId>`). */
export const CRM_ACCOUNTS_IMPORT_JOB_PREFIX = 'salesforce-accounts-import:';
export const CRM_ACCOUNTS_IMPORT_KIND = { kind: 'crm_accounts', label: 'Importación de clientes' } as const;

/** Cuentas por importación: cada una se lee del CRM y se procesa en la misma llamada, con su resultado. */
export const CRM_ACCOUNTS_IMPORT_MAX = 20;
/** Tope de `OFFSET` de la API del CRM. */
const CRM_OFFSET_MAX = 2000;
const FIELDS_CACHE_MS = 10 * 60 * 1000;

/**
 * Columnas informativas de la cuenta, si el CRM del holding las tiene (se comprueba contra los campos reales de la cuenta antes de
 * pedirlas, así un CRM sin ellas no falla). Nombres leídos del CRM de SimpliRoute el 23-11: "Status", "MRR" y "Fecha de activación".
 */
const ACCOUNT_DISPLAY_FIELDS = {
	status: ['Status__c'],
	mrr: ['last_mrr__c'],
	activated_at: ['Fecha_de_activacion__c'],
	currency: ['CurrencyIsoCode'],
	country: ['CountryName__c', 'BillingCountry'],
} as const;

export interface CrmAccountsSearchInput {
	/** Nombre de la cuenta (contiene). */
	query?: string;
	account_ids?: string[];
	/** Letra inicial del nombre (`A`–`Z`) o `#` para los que empiezan con un número. */
	letter?: string;
	date_from?: string;
	date_to?: string;
	/** `won`: cuentas con una oportunidad ganada cerrada en el rango; `activation`: por fecha de activación de la cuenta. */
	date_field?: 'won' | 'activation';
	page: number;
	limit: number;
	/** Etapas ganadas del holding (reglas de la integración). */
	stages: string[];
}

export interface CrmAccountEntityRef {
	id: string;
	legal_name: string | null;
	tax_id: string | null;
	/** Cliente al que ya pertenece; `null` = sin cliente. */
	client: { id: string; name: string | null } | null;
}

export interface CrmAccountRow {
	id: string;
	name: string | null;
	legal_name: string | null;
	tax_id: string | null;
	country: string | null;
	status: string | null;
	mrr: number | null;
	currency: string | null;
	activated_at: string | null;
	sapira: {
		/** `client`: ya es cliente (vinculado a la cuenta); `legal_entity`: hay una razón social con su identificador; `new`: no existe. */
		state: 'client' | 'legal_entity' | 'new';
		client: { id: string; name: string | null } | null;
		legal_entities: CrmAccountEntityRef[];
	};
}

export type CrmAccountEntityAction = 'assign' | 'keep' | 'create' | 'choose';

export interface CrmAccountPreview {
	id: string;
	name: string | null;
	found: boolean;
	tax_id: string | null;
	legal_name: string | null;
	client: { action: 'create' | 'link'; id: string | null; name: string | null };
	legal_entity: {
		/**
		 * `assign`: una razón social sin cliente con el mismo identificador se asigna · `keep`: ya existe y tiene cliente (o el cliente
		 * ya tiene la suya): no se reasigna · `create`: se crea · `choose`: la cuenta no trae identificador y quien importa elige.
		 */
		action: CrmAccountEntityAction;
		entities: CrmAccountEntityRef[];
		/** Solo `choose`: razones sociales sin cliente con un nombre parecido. */
		suggestions: CrmAccountEntityRef[];
		/** Nombre con que se crearía una razón social nueva. */
		new_name: string | null;
	};
	opportunities: { won: number; in_sapira: number };
}

export interface CrmAccountImportItem {
	account_id: string;
	legal_entity?: { mode: 'auto' | 'existing' | 'none'; id?: string };
	with_opportunities?: boolean;
}

export interface CrmAccountImportResult {
	account_id: string;
	name: string | null;
	status: 'created' | 'linked' | 'error';
	client: { id: string; name: string | null } | null;
	legal_entity: CrmAccountEntityRef | null;
	message: string | null;
}

const soqlText = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const soqlLike = (value: string) => soqlText(value).replace(/%/g, '\\%').replace(/_/g, '\\_');
const taxKey = (value: string | null | undefined) => (value ?? '').replace(/[\s.]+/g, '').toUpperCase();

/**
 * Cuentas del CRM → clientes de Sapira ("Traer un cliente antiguo desde el CRM", soporte SimpliRoute 23-11). La búsqueda es en vivo y
 * no escribe; la importación reutiliza el camino de siempre de las cuentas (`SalesforceSyncCompleteService`: tabla intermedia →
 * clasificar → cliente, contacto, razón social y vínculo con el ERP) y, si se pide, el de las oportunidades (`retry_full`). Nunca
 * duplica: el cliente se reconoce por su vínculo con la cuenta y la razón social por su identificador tributario.
 */
@Injectable()
export class CrmAccountsService {
	private readonly logger = new Logger(CrmAccountsService.name);
	private readonly accountFields = new Map<string, { at: number; fields: Set<string> | null }>();

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(SalesforceConnection) private readonly connections: Repository<SalesforceConnection>,
		private readonly salesforceService: SalesforceService,
		private readonly syncComplete: SalesforceSyncCompleteService,
		private readonly syncRuns: SalesforceSyncRunService,
		@InjectModel(SalesforceSchedulerJob.name) private readonly schedulerJobs: Model<SalesforceSchedulerJobDocument>,
		@InjectModel(SalesforceSyncLog.name) private readonly syncLogs: Model<SalesforceSyncLogDocument>,
		private readonly config: ConfigService
	) {}

	private async requireConnection(holdingId: string): Promise<void> {
		const connection = await this.connections.findOne({ where: { holding_id: holdingId } });

		if (!connection) throw new BadRequestException('La integración no está conectada');
		if (connection.is_active === false) throw new BadRequestException('La integración está pausada');
	}

	private async crmQuery(holdingId: string, soql: string): Promise<{ records: Row[]; totalSize: number }> {
		try {
			const result = await this.salesforceService.executeQuery(soql, holdingId);

			return { records: (result.data?.records ?? []) as Row[], totalSize: Number(result.data?.totalSize) || 0 };
		} catch (error) {
			throw new BadGatewayException(`El CRM no respondió: ${errorText(error)}`);
		}
	}

	/** Campos reales de la cuenta en el CRM del holding (10 minutos en memoria). `null` si el CRM no deja leerlos. */
	private async existingAccountFields(holdingId: string): Promise<Set<string> | null> {
		const cached = this.accountFields.get(holdingId);

		if (cached && Date.now() - cached.at < FIELDS_CACHE_MS) return cached.fields;
		let fields: Set<string> | null = null;

		try {
			const result = await this.salesforceService.executeQuery(
				`SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account'`,
				holdingId
			);

			fields = new Set(((result.data?.records ?? []) as Row[]).map((record) => String(record.QualifiedApiName)));
		} catch (error) {
			this.logger.warn(`No se pudieron leer los campos de la cuenta del CRM (${holdingId}): ${errorText(error)}`);
		}
		this.accountFields.set(holdingId, { at: Date.now(), fields });

		return fields;
	}

	/** Campos a pedir al CRM en la búsqueda: los que usan los mapeos del holding y, si existen, las columnas informativas. */
	private async searchFields(holdingId: string) {
		const [sources, existing] = await Promise.all([this.syncComplete.accountFieldSources(holdingId), this.existingAccountFields(holdingId)]);
		const simple = (path: string | undefined) =>
			(path ?? '')
				.split(',')
				.map((field) => field.trim())
				.filter((field) => /^[A-Za-z][A-Za-z0-9_]*$/.test(field));
		const mapped = [
			sources.client_entity.tax_id,
			sources.client_entity.legal_name,
			sources.client.country,
			sources.client.name_commercial,
		].flatMap(simple);
		// Sin la lista de campos del CRM solo se piden los de los mapeos (los mismos que ya lee la sincronización).
		const has = (field: string) => (existing ? existing.has(field) : false);
		const display = Object.fromEntries(
			Object.entries(ACCOUNT_DISPLAY_FIELDS).map(([key, candidates]) => [key, candidates.filter(has)])
		) as Record<keyof typeof ACCOUNT_DISPLAY_FIELDS, string[]>;
		const select = [...new Set(['Id', 'Name', ...mapped.filter((field) => !existing || existing.has(field)), ...Object.values(display).flat()])];

		return { select, sources, display };
	}

	// ── Búsqueda (en vivo, no escribe) ──────────────────────────────────────────────────────────────────────────────────────

	async search(holdingId: string, input: CrmAccountsSearchInput): Promise<Paginated<CrmAccountRow>> {
		await this.requireConnection(holdingId);
		const query = (input.query ?? '').trim();
		const ids = [...new Set(input.account_ids ?? [])];
		const hasDates = Boolean(input.date_from || input.date_to);

		if (!query && !ids.length && !input.letter && !hasDates) {
			throw validationException([{ field: 'query', message: 'Busca por nombre, ID, letra inicial o fecha' }]);
		}
		if (hasDates && !(input.date_from && input.date_to)) {
			throw validationException([{ field: input.date_from ? 'date_to' : 'date_from', message: 'Indica el inicio y el fin del período' }]);
		}
		if (hasDates && String(input.date_from) > String(input.date_to)) {
			throw validationException([{ field: 'date_from', message: 'La fecha inicial es posterior a la final' }]);
		}
		const offset = (input.page - 1) * input.limit;

		if (offset > CRM_OFFSET_MAX) throw validationException([{ field: 'page', message: 'Demasiados resultados: afina la búsqueda' }]);
		const { select, sources, display } = await this.searchFields(holdingId);
		const where = ['IsDeleted = false'];

		if (ids.length) where.push(`Id IN ('${ids.map(soqlText).join("','")}')`);
		if (query) where.push(`Name LIKE '%${soqlLike(query)}%'`);
		if (input.letter === '#')
			where.push(
				`(${'0123456789'
					.split('')
					.map((digit) => `Name LIKE '${digit}%'`)
					.join(' OR ')})`
			);
		else if (input.letter) where.push(`Name LIKE '${soqlLike(input.letter)}%'`);
		if (hasDates && input.date_field === 'activation') {
			const field = display.activated_at[0];

			if (!field)
				throw validationException([
					{ field: 'date_field', message: 'Tu CRM no tiene fecha de activación en la cuenta: busca por oportunidad ganada' },
				]);
			where.push(`${field} >= ${input.date_from}`, `${field} <= ${input.date_to}`);
		} else if (hasDates) {
			const stages = input.stages.map((stage) => `StageName = '${soqlText(stage)}'`).join(' OR ');

			where.push(
				`Id IN (SELECT AccountId FROM Opportunity WHERE IsDeleted = false AND (${stages}) AND CloseDate >= ${input.date_from} AND CloseDate <= ${input.date_to})`
			);
		}
		const condition = where.join(' AND ');
		const [count, page] = await Promise.all([
			this.crmQuery(holdingId, `SELECT COUNT() FROM Account WHERE ${condition}`),
			this.crmQuery(
				holdingId,
				`SELECT ${select.join(', ')} FROM Account WHERE ${condition} ORDER BY Name LIMIT ${input.limit} OFFSET ${offset}`
			),
		]);
		const text = (record: Row, path: string | undefined) => {
			const value = path && !path.includes(',') ? record[path] : null;

			return value === null || value === undefined || value === '' ? null : String(value);
		};
		const first = (record: Row, fields: readonly string[]) => fields.map((field) => text(record, field)).find(Boolean) ?? null;
		const rows = page.records.map((record) => {
			const mrr = first(record, display.mrr);

			return {
				id: String(record.Id),
				name: text(record, 'Name'),
				legal_name: text(record, sources.client_entity.legal_name),
				tax_id: normalizeTaxId(text(record, sources.client_entity.tax_id)),
				country: isoToCountryName(text(record, sources.client.country)) ?? first(record, display.country),
				status: first(record, display.status),
				mrr: mrr === null || Number.isNaN(Number(mrr)) ? null : Number(mrr),
				currency: first(record, display.currency),
				activated_at: first(record, display.activated_at),
			};
		});
		const [clients, entities] = await Promise.all([
			this.clientsByAccount(
				holdingId,
				rows.map((row) => row.id)
			),
			this.entitiesByTaxId(
				holdingId,
				rows.map((row) => row.tax_id)
			),
		]);
		const data: CrmAccountRow[] = rows.map((row) => {
			const client = clients.get(row.id) ?? null;
			const legalEntities = row.tax_id ? (entities.get(taxKey(row.tax_id)) ?? []) : [];

			return {
				...row,
				sapira: { state: client ? 'client' : legalEntities.length ? 'legal_entity' : 'new', client, legal_entities: legalEntities },
			};
		});

		return paginated(data, count.totalSize, input.page, input.limit);
	}

	/** Cliente de Sapira de cada cuenta: por el "ID en el CRM" del cliente o por el vínculo de la integración. */
	private async clientsByAccount(holdingId: string, accountIds: string[]): Promise<Map<string, { id: string; name: string | null }>> {
		if (!accountIds.length) return new Map();
		const rows = (await this.dataSource.query(
			`SELECT a.id AS account_id, c.id::text AS client_id, c.name_commercial
			FROM unnest($2::text[]) AS a(id)
			JOIN LATERAL (SELECT c.id, c.name_commercial FROM clients c WHERE c.holding_id = $1 AND (c.salesforce_account_id = a.id
					OR c.id IN (SELECT m.sapira_record_id FROM salesforce_object_mappings m WHERE m.holding_id = $1
						AND m.salesforce_object_type = 'Account' AND m.salesforce_object_id = a.id))
				ORDER BY (c.salesforce_account_id = a.id) DESC NULLS LAST LIMIT 1) c ON true`,
			[holdingId, accountIds]
		)) as Row[];

		return new Map(rows.map((row) => [String(row.account_id), { id: String(row.client_id), name: (row.name_commercial as string) ?? null }]));
	}

	private entityRef(row: Row): CrmAccountEntityRef {
		return {
			id: String(row.id),
			legal_name: (row.legal_name as string) ?? null,
			tax_id: (row.tax_id as string) ?? null,
			client: row.client_id ? { id: String(row.client_id), name: (row.client_name as string) ?? null } : null,
		};
	}

	/** Razones sociales del holding con su cliente (el vínculo principal, o el heredado `client_id`). */
	private async entities(holdingId: string, filter: string, params: unknown[]): Promise<Row[]> {
		return (await this.dataSource.query(
			`SELECT e.id::text AS id, e.legal_name, e.tax_id, COALESCE(x.client_id, e.client_id)::text AS client_id, c.name_commercial AS client_name
			FROM client_entities e
			LEFT JOIN LATERAL (SELECT x.client_id FROM client_entity_clients x WHERE x.client_entity_id = e.id ORDER BY x.is_primary DESC LIMIT 1) x ON true
			LEFT JOIN clients c ON c.id = COALESCE(x.client_id, e.client_id)
			WHERE e.holding_id = $1 AND ${filter}
			ORDER BY lower(e.legal_name)`,
			[holdingId, ...params]
		)) as Row[];
	}

	private async entitiesByTaxId(holdingId: string, taxIds: Array<string | null>): Promise<Map<string, CrmAccountEntityRef[]>> {
		const keys = [...new Set(taxIds.map(taxKey).filter(Boolean))];
		const byTax = new Map<string, CrmAccountEntityRef[]>();

		if (!keys.length) return byTax;
		const rows = await this.entities(holdingId, `upper(regexp_replace(COALESCE(e.tax_id, ''), '[[:space:].]+', '', 'g')) = ANY($2::text[])`, [
			keys,
		]);

		for (const row of rows) {
			const key = taxKey(row.tax_id as string);

			byTax.set(key, [...(byTax.get(key) ?? []), this.entityRef(row)]);
		}

		return byTax;
	}

	// ── Vista previa (no escribe) ───────────────────────────────────────────────────────────────────────────────────────────

	/** Oportunidades ganadas de cada cuenta, en vivo. */
	private async wonOpportunities(holdingId: string, accountIds: string[], stages: string[]): Promise<Map<string, string[]>> {
		const byAccount = new Map<string, string[]>();

		if (!accountIds.length || !stages.length) return byAccount;
		const { records } = await this.crmQuery(
			holdingId,
			`SELECT Id, AccountId FROM Opportunity WHERE IsDeleted = false AND AccountId IN ('${accountIds.map(soqlText).join("','")}') AND (${stages
				.map((stage) => `StageName = '${soqlText(stage)}'`)
				.join(' OR ')}) ORDER BY CloseDate DESC LIMIT 2000`
		);

		for (const record of records) {
			const accountId = String(record.AccountId);

			byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), String(record.Id)]);
		}

		return byAccount;
	}

	async preview(holdingId: string, accountIds: string[], stages: string[]): Promise<{ data: CrmAccountPreview[] }> {
		await this.requireConnection(holdingId);
		const ids = [...new Set(accountIds)];
		const won = await this.wonOpportunities(holdingId, ids, stages);
		const opportunityIds = [...won.values()].flat();
		const quotes = opportunityIds.length
			? ((await this.dataSource.query(
					`SELECT salesforce_opportunity_id FROM quotes WHERE holding_id = $1 AND salesforce_opportunity_id = ANY($2::text[])`,
					[holdingId, opportunityIds]
				)) as Row[])
			: [];
		const inSapira = new Set(quotes.map((quote) => String(quote.salesforce_opportunity_id)));
		const data: CrmAccountPreview[] = [];

		for (const accountId of ids) {
			const account = await this.syncComplete.fetchAccount(accountId, holdingId);

			if (!account?.Id) {
				data.push({
					id: accountId,
					name: null,
					found: false,
					tax_id: null,
					legal_name: null,
					client: { action: 'create', id: null, name: null },
					legal_entity: { action: 'create', entities: [], suggestions: [], new_name: null },
					opportunities: { won: 0, in_sapira: 0 },
				});
				continue;
			}
			const opportunities = won.get(account.Id) ?? won.get(accountId) ?? [];

			data.push({
				...(await this.previewAccount(holdingId, account)),
				opportunities: { won: opportunities.length, in_sapira: opportunities.filter((id) => inSapira.has(id)).length },
			});
		}

		return { data };
	}

	private async previewAccount(holdingId: string, account: SalesforceAccount): Promise<Omit<CrmAccountPreview, 'opportunities'>> {
		const mapped = await this.syncComplete.mapAccount(holdingId, account);
		const taxId = (mapped.clientEntity.tax_id as string) || null;
		const newName = (mapped.clientEntity.legal_name as string) || account.Name || null;
		const clientId = await this.syncComplete.findClientIdForAccount(holdingId, account.Id, mapped.client.client_number);
		const [clientRow] = clientId
			? ((await this.dataSource.query(`SELECT name_commercial FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId])) as Row[])
			: [];
		const base = {
			id: account.Id,
			name: account.Name ?? null,
			found: true,
			tax_id: taxId,
			legal_name: (mapped.clientEntity.legal_name as string) || null,
			client: clientId
				? { action: 'link' as const, id: clientId, name: (clientRow?.name_commercial as string) ?? null }
				: { action: 'create' as const, id: null, name: (mapped.client.name_commercial as string) ?? account.Name ?? null },
		};
		const entity = (action: CrmAccountEntityAction, entities: CrmAccountEntityRef[], suggestions: CrmAccountEntityRef[] = []) => ({
			...base,
			legal_entity: { action, entities, suggestions, new_name: newName },
		});

		if (taxId) {
			// Misma resolución que la importación: todas las razones sociales con ese identificador (genérico de exportación: además el nombre).
			const resolution = await this.syncComplete.resolveClientEntityPreview(holdingId, account);
			const entities = resolution.entities.length
				? (await this.entities(holdingId, `e.id = ANY($2::uuid[])`, [resolution.entities.map((item) => item.id)])).map((row) =>
						this.entityRef(row)
					)
				: [];

			if (!entities.length) return entity('create', []);

			return entity(entities.length === 1 && !entities[0].client ? 'assign' : 'keep', entities);
		}
		const own = clientId
			? (
					await this.entities(
						holdingId,
						`(e.client_id = $2::uuid OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = e.id AND x.client_id = $2::uuid))`,
						[clientId]
					)
				).map((row) => this.entityRef(row))
			: [];

		// Sin identificador en el CRM: si el cliente ya tiene razón social se conserva; si no, quien importa elige.
		if (own.length) return entity('keep', own);
		const words = [...new Set(`${account.Name ?? ''} ${newName ?? ''}`.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4))].slice(0, 6);
		const suggestions = words.length
			? (
					await this.entities(
						holdingId,
						`e.client_id IS NULL AND NOT EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = e.id)
							AND e.legal_name ILIKE ANY($2::text[])`,
						[words.map((word) => `%${word.replace(/[%_\\]/g, '\\$&')}%`)]
					)
				)
					.slice(0, 10)
					.map((row) => this.entityRef(row))
			: [];

		return entity('choose', [], suggestions);
	}

	// ── Importación ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	async import(holdingId: string, items: CrmAccountImportItem[], stages: string[]) {
		await this.requireConnection(holdingId);
		const startedAt = new Date();
		const environment = this.config.get<string>('NODE_ENV') || 'development';
		const jobId = `${CRM_ACCOUNTS_IMPORT_JOB_PREFIX}${environment}:${holdingId}:${randomUUID()}`;
		const chosen = items.filter((item) => item.legal_entity?.mode === 'existing');
		const missing = chosen.flatMap((item, index) =>
			item.legal_entity?.id ? [] : [{ field: `accounts.${index}.legal_entity.id`, message: 'Elige la razón social' }]
		);

		if (missing.length) throw validationException(missing);
		if (chosen.length) {
			const found = await this.entities(holdingId, `e.id = ANY($2::uuid[])`, [chosen.map((item) => item.legal_entity?.id)]);

			if (found.length !== new Set(chosen.map((item) => item.legal_entity?.id)).size) {
				throw validationException([{ field: 'accounts', message: 'Alguna razón social elegida no existe' }]);
			}
		}
		const results: CrmAccountImportResult[] = [];

		for (const item of items) {
			results.push(await this.importOne(holdingId, item));
		}
		const created = results.filter((result) => result.status === 'created').length;
		const linked = results.filter((result) => result.status === 'linked').length;
		const errors = results.filter((result) => result.status === 'error').length;
		const opportunities = await this.importOpportunities(
			holdingId,
			items.filter(
				(item) => item.with_opportunities && results.some((result) => result.account_id === item.account_id && result.status !== 'error')
			),
			stages
		);

		await this.recordHistory(holdingId, { jobId, environment, startedAt, results, created, linked, errors });

		return {
			data: results,
			created,
			linked,
			errors,
			opportunities,
			run_id: `crm-job:${jobId}`,
			message:
				errors === results.length
					? 'No se pudo importar ningún cliente'
					: [
							created ? `${created} ${created === 1 ? 'cliente creado' : 'clientes creados'}` : null,
							linked ? `${linked} ya ${linked === 1 ? 'existía' : 'existían'}` : null,
							errors ? `${errors} con error` : null,
						]
							.filter(Boolean)
							.join(' · '),
		};
	}

	private async importOne(holdingId: string, item: CrmAccountImportItem): Promise<CrmAccountImportResult> {
		const failed = (name: string | null, message: string): CrmAccountImportResult => ({
			account_id: item.account_id,
			name,
			status: 'error',
			client: null,
			legal_entity: null,
			message,
		});
		const account = await this.syncComplete.fetchAccount(item.account_id, holdingId);

		if (!account?.Id) return failed(null, 'No encontramos esa cuenta en el CRM');
		const mode = item.legal_entity?.mode ?? 'auto';

		try {
			const stats = await this.syncComplete.importAccountsFromCrm(holdingId, [account], {
				skipClientEntityFor: mode === 'auto' ? [] : [account.Id],
			});

			if (stats.errors.length)
				return failed(account.Name ?? null, stats.errors.map((error) => error.replace(/^Account \w+: /, '')).join(' · '));
			const mapped = await this.syncComplete.mapAccount(holdingId, account);
			const clientId = await this.syncComplete.findClientIdForAccount(holdingId, account.Id, mapped.client.client_number);

			if (!clientId) return failed(account.Name ?? null, 'No se pudo crear el cliente con los datos de la cuenta');
			let note: string | null = null;

			// Un cliente que ya existía sin cambios no pasa por la importación: la razón social sin cliente con su identificador se asigna igual.
			if (mode === 'auto' && mapped.clientEntity.tax_id) {
				const resolution = await this.syncComplete.resolveClientEntityPreview(holdingId, account);

				if (resolution.entities.length === 1) await this.syncComplete.linkOrphanClientEntity(holdingId, clientId, resolution.entities[0].id);
			}
			if (mode === 'existing' && item.legal_entity?.id) {
				const assigned = await this.syncComplete.linkOrphanClientEntity(holdingId, clientId, item.legal_entity.id);
				const [already] = assigned
					? []
					: ((await this.dataSource.query(`SELECT 1 FROM client_entity_clients WHERE client_entity_id = $1 AND client_id = $2`, [
							item.legal_entity.id,
							clientId,
						])) as Row[]);

				if (!assigned && !already) note = 'La razón social elegida ya tiene otro cliente: no se reasignó';
			}
			const [clientRow] = (await this.dataSource.query(`SELECT name_commercial FROM clients WHERE id = $1 AND holding_id = $2`, [
				clientId,
				holdingId,
			])) as Row[];
			const [entityRow] = await this.entities(
				holdingId,
				`(e.client_id = $2::uuid OR EXISTS (SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = e.id AND x.client_id = $2::uuid))`,
				[clientId]
			);

			return {
				account_id: account.Id,
				name: account.Name ?? null,
				status: stats.clientsCreated > 0 ? 'created' : 'linked',
				client: { id: clientId, name: (clientRow?.name_commercial as string) ?? null },
				legal_entity: entityRow ? this.entityRef(entityRow) : null,
				message: note,
			};
		} catch (error) {
			this.logger.error(`Importación de la cuenta ${item.account_id} del CRM falló (${holdingId}): ${errorText(error)}`);

			return failed(account.Name ?? null, errorText(error));
		}
	}

	/** Oportunidades ganadas de las cuentas pedidas, con la importación de siempre (`retry_full`): se sigue en el historial. */
	private async importOpportunities(holdingId: string, items: CrmAccountImportItem[], stages: string[]) {
		if (!items.length) return null;
		try {
			const won = await this.wonOpportunities(
				holdingId,
				items.map((item) => item.account_id),
				stages
			);
			const ids = [...won.values()].flat();

			if (!ids.length) return { run_id: null, accepted: 0, message: 'Estas cuentas no tienen oportunidades ganadas en el CRM' };
			const run = await this.syncRuns.createRun(holdingId, 'retry_full', ids);

			return { run_id: `crm-run:${run.id}`, accepted: run.total_items, message: 'Trayendo e importando sus oportunidades ganadas' };
		} catch (error) {
			return { run_id: null, accepted: 0, message: `Las oportunidades no se trajeron: ${errorText(error)}` };
		}
	}

	/** Deja la importación en el historial de la integración: el trabajo y una línea por cuenta (bitácora del CRM). */
	private async recordHistory(
		holdingId: string,
		run: {
			jobId: string;
			environment: string;
			startedAt: Date;
			results: CrmAccountImportResult[];
			created: number;
			linked: number;
			errors: number;
		}
	): Promise<void> {
		const completedAt = new Date();
		const durationSeconds = (completedAt.getTime() - run.startedAt.getTime()) / 1000;

		try {
			await this.schedulerJobs.create({
				jobId: run.jobId,
				status: run.errors === run.results.length ? 'failed' : 'completed',
				startedAt: run.startedAt,
				completedAt,
				durationSeconds,
				executionEnvironment: run.environment,
				holdingResults: [
					{
						holding_id: holdingId,
						success: run.errors < run.results.length,
						opportunities: 0,
						clientsCreated: run.created,
						clientsUpdated: run.linked,
						quotesCreated: 0,
						quotesUpdated: 0,
						sellersCreated: 0,
						accounts: run.results.length,
						durationSeconds,
					},
				],
			});
			await this.syncLogs.insertMany(
				run.results.map((result) => ({
					jobId: run.jobId,
					executionEnvironment: run.environment,
					holdingId,
					level: result.status === 'error' ? 'error' : 'info',
					stage: 'account',
					message:
						result.status === 'created'
							? 'Cliente creado'
							: result.status === 'linked'
								? 'El cliente ya existía'
								: 'No se pudo importar la cuenta',
					salesforceAccountId: result.account_id,
					errorMessage: result.status === 'error' ? (result.message ?? undefined) : undefined,
					integrationNotes: result.status === 'error' ? undefined : (result.message ?? undefined),
					metadata: { account_name: result.name, client_id: result.client?.id ?? null, client_entity_id: result.legal_entity?.id ?? null },
					occurredAt: new Date(),
				})),
				{ ordered: false }
			);
		} catch (error) {
			this.logger.error(`No se pudo registrar la importación de clientes del CRM en el historial (${holdingId}): ${errorText(error)}`);
		}
	}
}

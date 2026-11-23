// La cadena de servicios del CRM importa módulos que usan `uuid` (solo ESM): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@/logger/app-logger.service', () => ({ AppLoggerService: class AppLoggerService {} }));

import { BadGatewayException, BadRequestException } from '@nestjs/common';

import { CRM_ACCOUNTS_IMPORT_JOB_PREFIX, CrmAccountsService } from './crm-accounts';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const SIDAPT = '0015w00002mURaYAAW';
const ACME = '0015w00002AAAAAAA1';
const ENTITY = '000edbf8-49a2-42bb-9864-8efe72257cae';
const STAGES = ['Ganado', 'Closed Won'];
const FIELDS = [
	'Id',
	'Name',
	'RUT__c',
	'BusinessName__c',
	'DemoCountry__c',
	'Status__c',
	'last_mrr__c',
	'Fecha_de_activacion__c',
	'CurrencyIsoCode',
	'BillingCountry',
];

type Row = Record<string, unknown>;

/**
 * Doble del CRM y de la base: `crm` responde por tipo de consulta y guarda el SOQL; `db` responde por la tabla que se consulta.
 */
const build = (options: { fields?: string[] | Error; accounts?: Row[]; total?: number; opportunities?: Row[]; connection?: Row | null } = {}) => {
	const soql: string[] = [];
	const state = {
		clients: [] as Row[],
		entities: [] as Row[],
		links: [] as Array<{ entity: string; client: string }>,
		quotes: [] as string[],
	};
	const salesforceService = {
		executeQuery: jest.fn(async (query: string) => {
			soql.push(query);
			if (query.includes('FROM FieldDefinition')) {
				if (options.fields instanceof Error) throw options.fields;

				return { data: { records: (options.fields ?? FIELDS).map((name) => ({ QualifiedApiName: name })), totalSize: 0 } };
			}
			if (query.startsWith('SELECT COUNT()')) return { data: { records: [], totalSize: options.total ?? (options.accounts ?? []).length } };
			if (query.includes('FROM Opportunity WHERE')) return { data: { records: options.opportunities ?? [], totalSize: 0 } };

			return { data: { records: options.accounts ?? [], totalSize: (options.accounts ?? []).length } };
		}),
	};
	const entityRow = (entity: Row) => {
		const link = state.links.find((item) => item.entity === entity.id);
		const client = state.clients.find((item) => item.id === (link?.client ?? entity.client_id));

		return {
			id: entity.id,
			legal_name: entity.legal_name,
			tax_id: entity.tax_id,
			client_id: client?.id ?? null,
			client_name: client?.name_commercial ?? null,
		};
	};
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			if (sql.includes('FROM unnest')) {
				return (params[1] as string[]).flatMap((id) => {
					const client = state.clients.find((item) => item.salesforce_account_id === id);

					return client ? [{ account_id: id, client_id: client.id, name_commercial: client.name_commercial }] : [];
				});
			}
			if (sql.includes('FROM client_entities e')) {
				if (sql.includes('regexp_replace'))
					return state.entities
						.filter((entity) => (params[1] as string[]).includes(String(entity.tax_id).replace(/[\s.]/g, '').toUpperCase()))
						.map(entityRow);
				if (sql.includes('e.id = ANY'))
					return state.entities.filter((entity) => (params[1] as string[]).includes(String(entity.id))).map(entityRow);
				if (sql.includes('ILIKE ANY'))
					return state.entities
						.filter((entity) => !entity.client_id && !state.links.some((link) => link.entity === entity.id))
						.filter((entity) =>
							(params[1] as string[]).some((word) =>
								String(entity.legal_name).toLowerCase().includes(word.replace(/%/g, '').toLowerCase())
							)
						)
						.map(entityRow);

				return state.entities
					.filter(
						(entity) =>
							entity.client_id === params[1] || state.links.some((link) => link.entity === entity.id && link.client === params[1])
					)
					.map(entityRow);
			}
			if (sql.includes('FROM quotes'))
				return state.quotes.filter((id) => (params[1] as string[]).includes(id)).map((id) => ({ salesforce_opportunity_id: id }));
			if (sql.includes('FROM client_entity_clients WHERE'))
				return state.links.some((link) => link.entity === params[0] && link.client === params[1]) ? [{ ok: 1 }] : [];
			if (sql.includes('FROM clients WHERE id')) return state.clients.filter((client) => client.id === params[0]);

			return [];
		}),
	};
	const accountById = (id: string) => (options.accounts ?? []).find((account) => account.Id === id) ?? null;
	const taxOf = (account: Row) => (account.RUT__c ? String(account.RUT__c).replace(/[\s.]/g, '') : null);
	const syncComplete = {
		accountFieldSources: jest.fn(async () => ({
			client: { name_commercial: 'Name', country: 'DemoCountry__c', salesforce_account_id: 'Id' },
			client_entity: { tax_id: 'RUT__c', legal_name: 'BusinessName__c', legal_address: 'BillingStreet,BillingCity' },
		})),
		fetchAccount: jest.fn(async (id: string) => accountById(id)),
		mapAccount: jest.fn(async (_holding: string, account: Row) => ({
			client: { name_commercial: account.Name, client_number: account.Id },
			clientEntity: { tax_id: taxOf(account), legal_name: account.BusinessName__c ?? null },
		})),
		findClientIdForAccount: jest.fn(
			async (_holding: string, accountId: string) => state.clients.find((client) => client.salesforce_account_id === accountId)?.id ?? null
		),
		resolveClientEntityPreview: jest.fn(async (_holding: string, account: Row) => ({
			entities: state.entities.filter((entity) => entity.tax_id && entity.tax_id === taxOf(account)).map((entity) => ({ id: entity.id })),
		})),
		// Mismo contrato que el camino real: crea el cliente si no existe y, salvo que se pida saltarla, su razón social.
		importAccountsFromCrm: jest.fn(async (_holding: string, accounts: Row[], opts: { skipClientEntityFor?: string[] } = {}) => {
			const stats = { clientsCreated: 0, clientsUpdated: 0, errors: [] as string[] };

			for (const account of accounts) {
				if (account.Name === 'Falla') {
					stats.errors.push(`Account ${account.Id}: La cuenta no tiene país`);
					continue;
				}
				if (state.clients.some((client) => client.salesforce_account_id === account.Id)) continue;
				const client = { id: `client-${state.clients.length + 1}`, name_commercial: account.Name, salesforce_account_id: account.Id };

				state.clients.push(client);
				stats.clientsCreated += 1;
				if (!opts.skipClientEntityFor?.includes(String(account.Id)) && !taxOf(account)) {
					state.entities.push({
						id: `entity-new-${state.entities.length + 1}`,
						legal_name: account.Name,
						tax_id: null,
						client_id: client.id,
					});
				}
			}

			return stats;
		}),
		linkOrphanClientEntity: jest.fn(async (_holding: string, clientId: string, entityId: string) => {
			const entity = state.entities.find((item) => item.id === entityId);

			if (!entity || entity.client_id || state.links.some((link) => link.entity === entityId)) return false;
			state.links.push({ entity: entityId, client: clientId });

			return true;
		}),
	};
	const syncRuns = { createRun: jest.fn(async (_holding: string, _type: string, ids: string[]) => ({ id: 'run-1', total_items: ids.length })) };
	const schedulerJobs = { create: jest.fn() };
	const syncLogs = { insertMany: jest.fn() };
	const connections = {
		findOne: jest.fn(async () => (options.connection === undefined ? { holding_id: HOLDING, is_active: true } : options.connection)),
	};
	const service = new CrmAccountsService(
		dataSource as never,
		connections as never,
		salesforceService as never,
		syncComplete as never,
		syncRuns as never,
		schedulerJobs as never,
		syncLogs as never,
		{ get: () => 'test' } as never
	);

	return { service, soql, state, salesforceService, syncComplete, syncRuns, schedulerJobs, syncLogs, dataSource };
};

const sidapt = {
	Id: SIDAPT,
	Name: 'Sidapt',
	RUT__c: null,
	BusinessName__c: null,
	DemoCountry__c: 'CL',
	Status__c: 'Cliente',
	last_mrr__c: 839.14,
	CurrencyIsoCode: 'USD',
	Fecha_de_activacion__c: '2022-12-01',
};
const acme = { Id: ACME, Name: 'Acme', RUT__c: '76.517.784-7', BusinessName__c: 'Acme SpA', DemoCountry__c: 'CL' };
const search = (service: CrmAccountsService, input: Row) => service.search(HOLDING, { page: 1, limit: 20, stages: STAGES, ...input } as never);
const pageQuery = (soql: string[]) => soql.find((query) => query.includes('FROM Account') && !query.startsWith('SELECT COUNT()')) ?? '';

describe('CrmAccountsService · búsqueda de cuentas en el CRM (en vivo, no escribe)', () => {
	it('por nombre: contiene, escapa comillas y comodines, y devuelve la cuenta con sus datos del CRM', async () => {
		const { service, soql, syncComplete, dataSource } = build({ accounts: [sidapt] });
		const result = await search(service, { query: "Sid'apt 100%_" });

		expect(pageQuery(soql)).toContain("Name LIKE '%Sid\\'apt 100\\%\\_%'");
		expect(pageQuery(soql)).toContain('IsDeleted = false');
		expect(pageQuery(soql)).toContain('ORDER BY Name LIMIT 20 OFFSET 0');
		expect(result).toEqual(expect.objectContaining({ total: 1, currentPage: 1, pages: 1, limit: 20 }));
		expect(result.data[0]).toEqual({
			id: SIDAPT,
			name: 'Sidapt',
			legal_name: null,
			tax_id: null,
			country: 'Chile',
			status: 'Cliente',
			mrr: 839.14,
			currency: 'USD',
			activated_at: '2022-12-01',
			sapira: { state: 'new', client: null, legal_entities: [] },
		});
		// No escribe: ni tabla intermedia ni clientes.
		expect(syncComplete.importAccountsFromCrm).not.toHaveBeenCalled();
		expect(dataSource.query.mock.calls.every(([sql]) => /^\s*SELECT/i.test(String(sql)))).toBe(true);
	});

	it('por id de cuenta', async () => {
		const { service, soql } = build({ accounts: [sidapt] });

		await search(service, { account_ids: [SIDAPT] });
		expect(pageQuery(soql)).toContain(`Id IN ('${SIDAPT}')`);
	});

	it('por letra inicial, y # para los que empiezan con un número', async () => {
		const letter = build({ accounts: [] });

		await search(letter.service, { letter: 'S' });
		expect(pageQuery(letter.soql)).toContain("Name LIKE 'S%'");
		const digits = build({ accounts: [] });

		await search(digits.service, { letter: '#' });
		expect(pageQuery(digits.soql)).toContain("(Name LIKE '0%' OR Name LIKE '1%'");
	});

	it('por período: cuentas con una oportunidad ganada (etapas del holding) cerrada en el rango', async () => {
		const { service, soql } = build({ accounts: [] });

		await search(service, { date_from: '2022-01-01', date_to: '2022-12-31' });
		expect(pageQuery(soql)).toContain(
			"Id IN (SELECT AccountId FROM Opportunity WHERE IsDeleted = false AND (StageName = 'Ganado' OR StageName = 'Closed Won') AND CloseDate >= 2022-01-01 AND CloseDate <= 2022-12-31)"
		);
	});

	it('por fecha de activación; si el CRM no tiene ese campo, lo dice', async () => {
		const withField = build({ accounts: [] });

		await search(withField.service, { date_from: '2022-01-01', date_to: '2022-12-31', date_field: 'activation' });
		expect(pageQuery(withField.soql)).toContain('Fecha_de_activacion__c >= 2022-01-01 AND Fecha_de_activacion__c <= 2022-12-31');
		const without = build({ accounts: [], fields: ['Id', 'Name', 'RUT__c'] });

		await expect(search(without.service, { date_from: '2022-01-01', date_to: '2022-12-31', date_field: 'activation' })).rejects.toMatchObject({
			response: { errors: [{ field: 'date_field', message: expect.stringContaining('no tiene fecha de activación') }] },
		});
	});

	it('solo pide al CRM los campos que existen: un CRM sin las columnas informativas no falla', async () => {
		const { service, soql } = build({ accounts: [{ Id: ACME, Name: 'Acme', RUT__c: '76517784-7' }], fields: ['Id', 'Name', 'RUT__c'] });
		const result = await search(service, { query: 'acme' });

		expect(pageQuery(soql)).toMatch(/^SELECT Id, Name, RUT__c FROM Account/);
		expect(result.data[0]).toEqual(expect.objectContaining({ tax_id: '76517784-7', status: null, mrr: null, activated_at: null }));
	});

	it('si el CRM no deja leer sus campos, pide solo los de los mapeos del holding', async () => {
		const { service, soql } = build({ accounts: [], fields: new Error('sin acceso') });

		await search(service, { query: 'acme' });
		expect(pageQuery(soql)).toMatch(/^SELECT Id, Name, RUT__c, BusinessName__c, DemoCountry__c FROM Account/);
	});

	it('paginada: página y tamaño van al CRM y el total viene del conteo', async () => {
		const { service, soql } = build({ accounts: [sidapt], total: 57 });
		const result = await search(service, { letter: 'S', page: 3, limit: 25 });

		expect(pageQuery(soql)).toContain('LIMIT 25 OFFSET 50');
		expect(result).toEqual(expect.objectContaining({ total: 57, currentPage: 3, pages: 3, limit: 25 }));
		await expect(search(service, { letter: 'S', page: 200, limit: 25 })).rejects.toMatchObject({ response: { errors: [{ field: 'page' }] } });
	});

	it('dice si ya existe en Sapira: cliente vinculado a la cuenta, o razón social con el mismo RUT', async () => {
		const { service, state } = build({ accounts: [sidapt, acme] });

		state.clients.push({ id: 'client-9', name_commercial: 'Sidapt', salesforce_account_id: SIDAPT });
		state.entities.push({ id: ENTITY, legal_name: 'ACME SPA', tax_id: '76517784-7', client_id: null });
		const result = await search(service, { query: 'a' });

		expect(result.data[0].sapira).toEqual({ state: 'client', client: { id: 'client-9', name: 'Sidapt' }, legal_entities: [] });
		expect(result.data[1].sapira).toEqual({
			state: 'legal_entity',
			client: null,
			legal_entities: [{ id: ENTITY, legal_name: 'ACME SPA', tax_id: '76517784-7', client: null }],
		});
	});

	it('exige un criterio, un período completo y una integración conectada y activa', async () => {
		const { service } = build();

		await expect(search(service, {})).rejects.toMatchObject({ response: { errors: [{ field: 'query' }] } });
		await expect(search(service, { date_from: '2022-01-01' })).rejects.toMatchObject({ response: { errors: [{ field: 'date_to' }] } });
		await expect(search(service, { date_from: '2023-01-01', date_to: '2022-01-01' })).rejects.toMatchObject({
			response: { errors: [{ field: 'date_from' }] },
		});
		await expect(search(build({ connection: null }).service, { query: 'a' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(search(build({ connection: { is_active: false } }).service, { query: 'a' })).rejects.toBeInstanceOf(BadRequestException);
	});

	it('si el CRM no responde → 502 con el motivo', async () => {
		const { service, salesforceService } = build();

		salesforceService.executeQuery.mockImplementation(async (query: string) => {
			if (query.includes('FieldDefinition')) return { data: { records: [], totalSize: 0 } };
			throw new Error('timeout');
		});
		await expect(search(service, { query: 'a' })).rejects.toBeInstanceOf(BadGatewayException);
	});
});

describe('CrmAccountsService · vista previa (no escribe)', () => {
	it('cuenta sin RUT (SIDAPT): crea el cliente y deja elegir la razón social, sugiriendo las que no tienen cliente', async () => {
		const { service, state, syncComplete } = build({
			accounts: [sidapt],
			opportunities: [
				{ Id: '006A', AccountId: SIDAPT },
				{ Id: '006B', AccountId: SIDAPT },
			],
		});

		state.entities.push({ id: ENTITY, legal_name: 'SERVICIOS INTEGRADOS SIDAPT LIMITADA', tax_id: '76299358-9', client_id: null });
		state.quotes.push('006A');
		const { data } = await service.preview(HOLDING, [SIDAPT], STAGES);

		expect(data[0]).toEqual({
			id: SIDAPT,
			name: 'Sidapt',
			found: true,
			tax_id: null,
			legal_name: null,
			client: { action: 'create', id: null, name: 'Sidapt' },
			legal_entity: {
				action: 'choose',
				entities: [],
				suggestions: [{ id: ENTITY, legal_name: 'SERVICIOS INTEGRADOS SIDAPT LIMITADA', tax_id: '76299358-9', client: null }],
				new_name: 'Sidapt',
			},
			opportunities: { won: 2, in_sapira: 1 },
		});
		expect(syncComplete.importAccountsFromCrm).not.toHaveBeenCalled();
	});

	it('con RUT: sin razón social → se crea; una sola sin cliente → se asigna; con cliente → no se reasigna', async () => {
		const create = build({ accounts: [acme] });

		expect((await create.service.preview(HOLDING, [ACME], STAGES)).data[0].legal_entity.action).toBe('create');
		const assign = build({ accounts: [acme] });

		assign.state.entities.push({ id: ENTITY, legal_name: 'ACME SPA', tax_id: '76517784-7', client_id: null });
		expect((await assign.service.preview(HOLDING, [ACME], STAGES)).data[0].legal_entity).toEqual(
			expect.objectContaining({ action: 'assign', entities: [expect.objectContaining({ id: ENTITY, client: null })] })
		);
		const keep = build({ accounts: [acme] });

		keep.state.clients.push({ id: 'client-7', name_commercial: 'Otro', salesforce_account_id: 'x' });
		keep.state.entities.push({ id: ENTITY, legal_name: 'ACME SPA', tax_id: '76517784-7', client_id: 'client-7' });
		expect((await keep.service.preview(HOLDING, [ACME], STAGES)).data[0].legal_entity).toEqual(
			expect.objectContaining({ action: 'keep', entities: [expect.objectContaining({ client: { id: 'client-7', name: 'Otro' } })] })
		);
	});

	it('cliente que ya existe: se vincula (no se crea otro); una cuenta que no está en el CRM se marca', async () => {
		const { service, state } = build({ accounts: [sidapt] });

		state.clients.push({ id: 'client-9', name_commercial: 'Sidapt', salesforce_account_id: SIDAPT });
		const { data } = await service.preview(HOLDING, [SIDAPT, ACME], STAGES);

		expect(data[0].client).toEqual({ action: 'link', id: 'client-9', name: 'Sidapt' });
		expect(data[1]).toEqual(expect.objectContaining({ id: ACME, found: false }));
	});
});

describe('CrmAccountsService · importación', () => {
	it('cliente nuevo: lo crea por el camino de siempre y lo deja en el historial', async () => {
		const { service, state, syncComplete, schedulerJobs, syncLogs } = build({ accounts: [sidapt] });
		const result = await service.import(HOLDING, [{ account_id: SIDAPT }], STAGES);

		expect(syncComplete.importAccountsFromCrm).toHaveBeenCalledWith(HOLDING, [sidapt], { skipClientEntityFor: [] });
		expect(state.clients).toHaveLength(1);
		expect(result).toEqual(
			expect.objectContaining({
				created: 1,
				linked: 0,
				errors: 0,
				opportunities: null,
				message: '1 cliente creado',
				run_id: expect.stringContaining(`crm-job:${CRM_ACCOUNTS_IMPORT_JOB_PREFIX}test:${HOLDING}:`),
			})
		);
		expect(result.data[0]).toEqual(
			expect.objectContaining({
				account_id: SIDAPT,
				status: 'created',
				client: { id: 'client-1', name: 'Sidapt' },
				legal_entity: expect.objectContaining({ legal_name: 'Sidapt' }),
			})
		);
		expect(schedulerJobs.create).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: expect.stringContaining(CRM_ACCOUNTS_IMPORT_JOB_PREFIX),
				status: 'completed',
				holdingResults: [expect.objectContaining({ holding_id: HOLDING, accounts: 1, clientsCreated: 1, clientsUpdated: 0 })],
			})
		);
		expect(syncLogs.insertMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					stage: 'account',
					level: 'info',
					holdingId: HOLDING,
					salesforceAccountId: SIDAPT,
					metadata: expect.objectContaining({ client_id: 'client-1' }),
				}),
			],
			{ ordered: false }
		);
	});

	it('cliente que ya existe: no duplica; importar dos veces la misma cuenta deja un solo cliente', async () => {
		const { service, state } = build({ accounts: [sidapt] });
		const first = await service.import(HOLDING, [{ account_id: SIDAPT }], STAGES);
		const second = await service.import(HOLDING, [{ account_id: SIDAPT }], STAGES);

		expect(first.data[0].status).toBe('created');
		expect(second.data[0]).toEqual(expect.objectContaining({ status: 'linked', client: { id: 'client-1', name: 'Sidapt' } }));
		expect(second).toEqual(expect.objectContaining({ created: 0, linked: 1, message: '1 ya existía' }));
		expect(state.clients).toHaveLength(1);
		expect(state.entities).toHaveLength(1);
	});

	it('razón social sin cliente con el mismo RUT: se asigna al cliente', async () => {
		const { service, state, syncComplete } = build({ accounts: [acme] });

		state.entities.push({ id: ENTITY, legal_name: 'ACME SPA', tax_id: '76517784-7', client_id: null });
		const result = await service.import(HOLDING, [{ account_id: ACME }], STAGES);

		expect(syncComplete.linkOrphanClientEntity).toHaveBeenCalledWith(HOLDING, 'client-1', ENTITY);
		expect(state.links).toEqual([{ entity: ENTITY, client: 'client-1' }]);
		expect(result.data[0].legal_entity).toEqual({
			id: ENTITY,
			legal_name: 'ACME SPA',
			tax_id: '76517784-7',
			client: { id: 'client-1', name: 'Acme' },
		});
		expect(state.entities).toHaveLength(1);
	});

	it('cuenta sin RUT con una razón social elegida (SIDAPT): la asigna y no crea otra; repetirlo no cambia nada', async () => {
		const { service, state, syncComplete } = build({ accounts: [sidapt] });

		state.entities.push({ id: ENTITY, legal_name: 'SERVICIOS INTEGRADOS SIDAPT LIMITADA', tax_id: '76299358-9', client_id: null });
		const item = { account_id: SIDAPT, legal_entity: { mode: 'existing' as const, id: ENTITY } };
		const result = await service.import(HOLDING, [item], STAGES);

		expect(syncComplete.importAccountsFromCrm).toHaveBeenCalledWith(HOLDING, [sidapt], { skipClientEntityFor: [SIDAPT] });
		expect(state.entities).toHaveLength(1);
		expect(state.links).toEqual([{ entity: ENTITY, client: 'client-1' }]);
		expect(result.data[0]).toEqual(
			expect.objectContaining({ status: 'created', message: null, legal_entity: expect.objectContaining({ id: ENTITY, tax_id: '76299358-9' }) })
		);
		const again = await service.import(HOLDING, [item], STAGES);

		expect(again.data[0]).toEqual(expect.objectContaining({ status: 'linked', message: null }));
		expect(state.links).toHaveLength(1);
	});

	it('la razón social elegida ya tiene otro cliente: no se reasigna y se avisa; sin razón social: no crea ninguna', async () => {
		const { service, state } = build({ accounts: [sidapt, acme] });

		state.clients.push({ id: 'client-7', name_commercial: 'Otro', salesforce_account_id: 'x' });
		state.entities.push({ id: ENTITY, legal_name: 'DE OTRO', tax_id: '1-9', client_id: 'client-7' });
		const result = await service.import(
			HOLDING,
			[
				{ account_id: SIDAPT, legal_entity: { mode: 'existing', id: ENTITY } },
				{ account_id: ACME, legal_entity: { mode: 'none' } },
			],
			STAGES
		);

		expect(result.data[0]).toEqual(
			expect.objectContaining({
				status: 'created',
				message: 'La razón social elegida ya tiene otro cliente: no se reasignó',
				legal_entity: null,
			})
		);
		expect(result.data[1]).toEqual(expect.objectContaining({ status: 'created', legal_entity: null }));
		expect(state.entities).toHaveLength(1);
		await expect(service.import(HOLDING, [{ account_id: SIDAPT, legal_entity: { mode: 'existing' } }], STAGES)).rejects.toMatchObject({
			response: { errors: [{ field: 'accounts.0.legal_entity.id' }] },
		});
		await expect(
			service.import(HOLDING, [{ account_id: SIDAPT, legal_entity: { mode: 'existing', id: '99999999-9999-4999-8999-999999999999' } }], STAGES)
		).rejects.toMatchObject({ response: { errors: [{ field: 'accounts' }] } });
	});

	it('con oportunidades: trae las ganadas de la cuenta con la importación de siempre', async () => {
		const { service, syncRuns, soql } = build({
			accounts: [sidapt, acme],
			opportunities: [
				{ Id: '006A', AccountId: SIDAPT },
				{ Id: '006B', AccountId: SIDAPT },
			],
		});
		const result = await service.import(HOLDING, [{ account_id: SIDAPT, with_opportunities: true }, { account_id: ACME }], STAGES);

		expect(soql.find((query) => query.includes('FROM Opportunity WHERE'))).toContain(`AccountId IN ('${SIDAPT}')`);
		expect(syncRuns.createRun).toHaveBeenCalledWith(HOLDING, 'retry_full', ['006A', '006B']);
		expect(result.opportunities).toEqual({ run_id: 'crm-run:run-1', accepted: 2, message: 'Trayendo e importando sus oportunidades ganadas' });
	});

	it('una importación de oportunidades en curso no bota la de clientes: se avisa', async () => {
		const { service, syncRuns } = build({ accounts: [sidapt], opportunities: [{ Id: '006A', AccountId: SIDAPT }] });

		syncRuns.createRun.mockRejectedValueOnce(new Error('Ya existe una ejecución de este tipo en curso para el holding'));
		const result = await service.import(HOLDING, [{ account_id: SIDAPT, with_opportunities: true }], STAGES);

		expect(result.created).toBe(1);
		expect(result.opportunities).toEqual(
			expect.objectContaining({ run_id: null, message: expect.stringContaining('Las oportunidades no se trajeron') })
		);
	});

	it('errores por cuenta: la que falla no detiene a las demás y queda en el historial', async () => {
		const failing = { Id: '0015w00002FFFFFFF1', Name: 'Falla' };
		const { service, schedulerJobs, syncLogs, syncRuns } = build({
			accounts: [failing, sidapt],
			opportunities: [{ Id: '006A', AccountId: '0015w00002FFFFFFF1' }],
		});
		const result = await service.import(
			HOLDING,
			[{ account_id: '0015w00002FFFFFFF1', with_opportunities: true }, { account_id: SIDAPT }, { account_id: '0015w00002ZZZZZZZ1' }],
			STAGES
		);

		expect(result.data.map((item) => item.status)).toEqual(['error', 'created', 'error']);
		expect(result.data[0].message).toBe('La cuenta no tiene país');
		expect(result.data[2].message).toBe('No encontramos esa cuenta en el CRM');
		expect(result).toEqual(expect.objectContaining({ created: 1, errors: 2, message: '1 cliente creado · 2 con error' }));
		// Las oportunidades de una cuenta que falló no se traen.
		expect(syncRuns.createRun).not.toHaveBeenCalled();
		expect(schedulerJobs.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
		expect(syncLogs.insertMany.mock.calls[0][0].map((log: Row) => log.level)).toEqual(['error', 'info', 'error']);
	});
});

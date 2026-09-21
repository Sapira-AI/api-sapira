import { BadRequestException, NotFoundException } from '@nestjs/common';

import { BigQueryService } from './bigquery.service';

describe('BigQueryService', () => {
	const buildService = () => {
		const stripeCustomerRepository = {
			findOne: jest.fn(),
			update: jest.fn(),
			save: jest.fn(),
		};
		const bigQueryConnectionRepository = {
			findOne: jest.fn(),
			update: jest.fn(),
		};
		const quantityImportRepository = {
			findOne: jest.fn(),
			find: jest.fn().mockResolvedValue([]),
			findAndCount: jest.fn().mockResolvedValue([[], 0]),
			create: jest.fn((value) => ({ ...value })),
			save: jest.fn((value) => Promise.resolve({ id: value.id ?? 'import-1', ...value })),
		};
		const notificationsService = {
			createOrUpdate: jest.fn(),
			resolveByDeduplicationKey: jest.fn(),
		};
		const dataSource = { query: jest.fn().mockResolvedValue([]) };

		const service = new BigQueryService(
			stripeCustomerRepository as any,
			bigQueryConnectionRepository as any,
			quantityImportRepository as any,
			notificationsService as any,
			dataSource as any
		);

		return {
			service,
			stripeCustomerRepository,
			bigQueryConnectionRepository,
			quantityImportRepository,
			notificationsService,
			dataSource,
		};
	};

	describe('executeQuery', () => {
		it('resuelve el cliente por holding y mapea filas, total y esquema', async () => {
			const { service } = buildService();
			const query = jest.fn().mockResolvedValue([[{ id: 1, name: 'Ejemplo' }]]);
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({ query } as any);

			const result = await service.executeQuery('holding-1', { query: 'SELECT 1', params: {} });

			expect(query).toHaveBeenCalledWith({ query: 'SELECT 1', params: {}, location: 'US' });
			expect(result).toEqual({
				rows: [{ id: 1, name: 'Ejemplo' }],
				totalRows: 1,
				schema: [{ name: 'id' }, { name: 'name' }],
			});
		});

		it('lanza BadRequestException cuando no hay conexión para el holding', async () => {
			const { service } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue(null);

			await expect(service.executeQuery('holding-1', { query: 'SELECT 1' })).rejects.toBeInstanceOf(BadRequestException);
		});

		it('lanza BadRequestException cuando falta el holdingId', async () => {
			const { service } = buildService();
			const spy = jest.spyOn(service, 'getBigQueryClientForHolding');

			await expect(service.executeQuery('', { query: 'SELECT 1' })).rejects.toBeInstanceOf(BadRequestException);
			expect(spy).not.toHaveBeenCalled();
		});
	});

	describe('getDatasets', () => {
		it('resuelve por holding y devuelve ids', async () => {
			const { service } = buildService();
			const getDatasets = jest.fn().mockResolvedValue([[{ id: 'finance' }, { id: 'sales' }]]);
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({ getDatasets } as any);

			await expect(service.getDatasets('holding-1')).resolves.toEqual(['finance', 'sales']);
		});

		it('lanza BadRequestException sin conexión', async () => {
			const { service } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue(null);

			await expect(service.getDatasets('holding-1')).rejects.toBeInstanceOf(BadRequestException);
		});
	});

	describe('getTables', () => {
		it('resuelve por holding y devuelve ids de tablas del dataset', async () => {
			const { service } = buildService();
			const getTables = jest.fn().mockResolvedValue([[{ id: 'sapira_stripe' }]]);
			const dataset = jest.fn().mockReturnValue({ getTables });
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({ dataset } as any);

			await expect(service.getTables('holding-1', 'finance')).resolves.toEqual(['sapira_stripe']);
			expect(dataset).toHaveBeenCalledWith('finance');
		});

		it('lanza BadRequestException sin conexión', async () => {
			const { service } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue(null);

			await expect(service.getTables('holding-1', 'finance')).rejects.toBeInstanceOf(BadRequestException);
		});
	});

	describe('getProjectInfo', () => {
		it('devuelve isConfigured false cuando no hay conexión', async () => {
			const { service } = buildService();
			jest.spyOn(service, 'getConnectionForHolding').mockResolvedValue(null);

			await expect(service.getProjectInfo('holding-1')).resolves.toEqual({
				projectId: 'No configurado',
				clientEmail: 'No configurado',
				isConfigured: false,
			});
		});

		it('devuelve project_id y client_email derivado cuando hay conexión', async () => {
			const { service } = buildService();
			jest.spyOn(service, 'getConnectionForHolding').mockResolvedValue({
				project_id: 'datawarehouse-a2e2',
				credentials: JSON.stringify({ client_email: 'svc@datawarehouse-a2e2.iam.gserviceaccount.com' }),
			} as any);

			await expect(service.getProjectInfo('holding-1')).resolves.toEqual({
				projectId: 'datawarehouse-a2e2',
				clientEmail: 'svc@datawarehouse-a2e2.iam.gserviceaccount.com',
				isConfigured: true,
			});
		});

		it('lanza BadRequestException cuando falta el holdingId', async () => {
			const { service } = buildService();

			await expect(service.getProjectInfo('')).rejects.toBeInstanceOf(BadRequestException);
		});
	});

	describe('getCurrentMonthRange', () => {
		it('calcula el mes en curso en zona America/Santiago', () => {
			const { service } = buildService();

			expect(service.getCurrentMonthRange(new Date('2026-08-15T12:00:00Z'))).toEqual({
				monthStart: '2026-08-01',
				monthEnd: '2026-09-01',
			});
		});

		it('cruza el fin de año correctamente', () => {
			const { service } = buildService();

			expect(service.getCurrentMonthRange(new Date('2026-12-20T12:00:00Z'))).toEqual({
				monthStart: '2026-12-01',
				monthEnd: '2027-01-01',
			});
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Cantidades variables: sapira_base → sapira_quantity_imports → quantities
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Payload real de producción. La primera fila se mapea vía quote_line_id; la segunda
	 * no trae ninguno de los cuatro IDs, así que es irresoluble por definición.
	 */
	const DWH_ROW_MAPEABLE = {
		billing_date: { value: '2026-08-01' },
		sf_id: '0015w00002sxiepAAA',
		business_name: 'Vendomatica PE',
		entity_name: 'Vendomatica PE',
		tin: null,
		account: '',
		country: 'Peru',
		product: 'WSP PRO',
		unit: 'Mensajes',
		currency: 'USD',
		quantity: '15000',
		unit_price: '0.05',
		gross_local_amount: '750',
		quote_line_id: '0QLRO00000INNuP4AX',
		opportunity_id: '006RO00000c2p8bYAA',
		sapira_contract_id: null,
		sapira_contract_item_id: null,
		status: 'RECURRENTE',
	};

	const DWH_ROW_SIN_IDS = {
		billing_date: { value: '2026-08-01' },
		sf_id: '001RO00000DkSLBYA3',
		business_name: 'AGN Hortfruti',
		entity_name: 'A.G.N. GUIMARAES COMERCIO ATACADO E VAREJO DE GENEROS ALIMENTICIOS LTDA',
		tin: '00.965.070/0001-84',
		account: '',
		country: 'Brasil',
		product: 'WSP PRO',
		unit: 'Mensajes',
		currency: 'BRL',
		quantity: '33000',
		unit_price: '0.14',
		gross_local_amount: '4620',
		quote_line_id: null,
		opportunity_id: null,
		sapira_contract_id: null,
		sapira_contract_item_id: null,
		status: 'RECURRENTE',
	};

	const CONTRACT_ITEM_ID = '11111111-1111-4111-8111-111111111111';
	const CONTRACT_ID = '22222222-2222-4222-8222-222222222222';

	const buildImport = (overrides: Record<string, unknown> = {}) => ({
		id: 'import-1',
		holding_id: 'holding-1',
		sf_id: '0015w00002sxiepAAA',
		billing_date: '2026-08-01',
		product: 'WSP PRO',
		period: '2026-08-01',
		quantity: '15000',
		unit_price: '0.05',
		unit_of_measure: 'Mensajes',
		account: null,
		currency: 'USD',
		gross_local_amount: '750',
		business_name: 'Vendomatica PE',
		dwh_status: 'RECURRENTE',
		sapira_contract_id: null,
		sapira_contract_item_id: null,
		quote_line_id: '0QLRO00000INNuP4AX',
		opportunity_id: '006RO00000c2p8bYAA',
		resolved_contract_item_id: null,
		resolved_contract_id: null,
		resolution_source: null,
		integration_status: 'pending',
		integration_reason: null,
		quantity_id: null,
		source_hash: 'hash-1',
		...overrides,
	});

	const buildCandidate = (overrides: Record<string, unknown> = {}) => ({
		id: CONTRACT_ITEM_ID,
		contract_id: CONTRACT_ID,
		holding_id: 'holding-1',
		quote_item_number: '0QLRO00000INNuP4AX',
		unit_price: '0.05',
		quantity: '1',
		item_currency: 'USD',
		contract_currency: 'USD',
		salesforce_opportunity_id: '006RO00000c2p8bYAA',
		...overrides,
	});

	/** Enruta el mock de dataSource según el SQL, que es lo único que distingue las consultas. */
	const wireDataSource = (
		dataSource: { query: jest.Mock },
		options: {
			candidates?: Array<Record<string, unknown>>;
			existingQuantities?: Record<string, Array<Record<string, unknown>>>;
			onInsert?: (params: unknown[]) => Promise<Array<{ id: string }>>;
		} = {}
	) => {
		const { candidates = [], existingQuantities = {}, onInsert } = options;

		dataSource.query.mockImplementation((sql: string, params: unknown[] = []) => {
			if (sql.includes('FROM contract_items')) {
				return Promise.resolve(candidates);
			}
			if (sql.includes('FROM quantities')) {
				return Promise.resolve(existingQuantities[`${params[0]}|${params[1]}`] ?? []);
			}
			if (sql.includes('INSERT INTO quantities')) {
				return onInsert ? onInsert(params) : Promise.resolve([{ id: 'quantity-1' }]);
			}
			if (sql.includes('UPDATE quantities')) {
				return Promise.resolve([{ id: params[0], unit_price: params[2], quantity: params[3] }]);
			}
			return Promise.resolve([]);
		});
	};

	describe('resolveDateRange', () => {
		it('sin rango explícito usa el mes en curso, con ambos extremos inclusivos', () => {
			const { service } = buildService();
			const { monthStart } = service.getCurrentMonthRange();

			const range = service.resolveDateRange();

			expect(range.from).toBe(monthStart);
			// `to` es el último día del mes, no el primero del siguiente.
			expect(range.to >= range.from).toBe(true);
			expect(range.to.slice(0, 7)).toBe(monthStart.slice(0, 7));
		});

		it('respeta el rango explícito tal cual', () => {
			const { service } = buildService();

			expect(service.resolveDateRange({ from: '2026-07-01', to: '2026-07-31' })).toEqual({ from: '2026-07-01', to: '2026-07-31' });
		});

		it('rechaza un rango con un solo extremo, que dejaría la ventana abierta', () => {
			const { service } = buildService();

			expect(() => service.resolveDateRange({ from: '2026-07-01' })).toThrow(BadRequestException);
			expect(() => service.resolveDateRange({ to: '2026-07-31' })).toThrow(BadRequestException);
		});

		it('rechaza un rango invertido', () => {
			const { service } = buildService();

			expect(() => service.resolveDateRange({ from: '2026-07-31', to: '2026-07-01' })).toThrow(BadRequestException);
		});
	});

	describe('segmentación por rango', () => {
		it('la fase 1 consulta el DWH con el rango pedido, inclusivo en ambos extremos', async () => {
			const { service, quantityImportRepository } = buildService();
			const query = jest.fn().mockResolvedValue([[]]);
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({ query } as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			const result = await service.ingestSapiraQuantities('holding-1', { from: '2026-07-01', to: '2026-07-31' });

			expect(query.mock.calls[0][0].query).toContain('billing_date >= @from AND billing_date <= @to');
			expect(query.mock.calls[0][0].params).toEqual({ from: '2026-07-01', to: '2026-07-31' });
			expect(result.range).toEqual({ from: '2026-07-01', to: '2026-07-31' });
		});

		it('la fase 2 acota por period y no arrastra pendientes de otros meses', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([]);
			wireDataSource(dataSource, { candidates: [] });

			const result = await service.integrateSapiraQuantities('holding-1', { range: { from: '2026-07-05', to: '2026-08-20' } });

			const where = quantityImportRepository.find.mock.calls[0][0].where;
			// Between sobre los period (primer día de mes) de ambos extremos del rango.
			expect(where.period._value).toEqual(['2026-07-01', '2026-08-01']);
			expect(result.range).toEqual({ from: '2026-07-05', to: '2026-08-20' });
		});

		it('la fase 2 no consulta BigQuery', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			const getClient = jest.spyOn(service, 'getBigQueryClientForHolding');
			quantityImportRepository.find.mockResolvedValue([]);
			wireDataSource(dataSource, { candidates: [] });

			await service.integrateSapiraQuantities('holding-1', { range: { from: '2026-07-01', to: '2026-07-31' } });

			expect(getClient).not.toHaveBeenCalled();
		});

		it('syncSapiraQuantities resuelve el rango una sola vez y pasa el mismo a ambas fases', async () => {
			const { service } = buildService();
			const ingest = jest
				.spyOn(service, 'ingestSapiraQuantities')
				.mockResolvedValue({ range: { from: '2026-07-01', to: '2026-07-31' } } as any);
			const integrate = jest
				.spyOn(service, 'integrateSapiraQuantities')
				.mockResolvedValue({ range: { from: '2026-07-01', to: '2026-07-31' } } as any);

			const result = await service.syncSapiraQuantities('holding-1', { from: '2026-07-01', to: '2026-07-31' });

			// Ambas fases reciben el MISMO rango ya resuelto: si cada una lo resolviera por su cuenta,
			// una corrida iniciada al filo del cambio de mes podría ingerir una ventana e integrar otra.
			expect(ingest).toHaveBeenCalledWith('holding-1', { from: '2026-07-01', to: '2026-07-31' });
			expect(integrate).toHaveBeenCalledWith('holding-1', { range: { from: '2026-07-01', to: '2026-07-31' } });
			expect(result.range).toEqual({ from: '2026-07-01', to: '2026-07-31' });
		});

		it('la clave de deduplicación de las agregadas lleva el rango, no el mes en curso', async () => {
			const { service, quantityImportRepository, dataSource, notificationsService } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport({ quote_line_id: null, opportunity_id: null })]);
			wireDataSource(dataSource, { candidates: [] });

			await service.integrateSapiraQuantities('holding-1', { range: { from: '2026-07-01', to: '2026-07-31' } });

			const unmapped = notificationsService.createOrUpdate.mock.calls.find(([, dto]) => dto.type === 'bigquery_quantities_unmapped');
			expect(unmapped[1].deduplication_key).toBe('bigquery_quantities_unmapped:holding-1:2026-07-01:2026-07-31');
			expect(unmapped[1].metadata).toMatchObject({ range_from: '2026-07-01', range_to: '2026-07-31' });
		});

		it('un backfill limpio NO resuelve la alerta abierta del mes en curso', async () => {
			const { service, quantityImportRepository, dataSource, notificationsService } = buildService();
			quantityImportRepository.find.mockResolvedValue([]);
			wireDataSource(dataSource, { candidates: [] });
			const { monthStart } = service.getCurrentMonthRange();

			await service.integrateSapiraQuantities('holding-1', { range: { from: '2026-01-01', to: '2026-01-31' } });

			// Regresión: con la clave fija del mes actual, este backfill sin hallazgos habría cerrado
			// en silencio una notificación legítima y vigente.
			const resueltas = notificationsService.resolveByDeduplicationKey.mock.calls.map(([, key]) => key);
			expect(resueltas).toContain('bigquery_quantities_unmapped:holding-1:2026-01-01:2026-01-31');
			expect(resueltas.some((key: string) => key.includes(monthStart))).toBe(false);
		});
	});

	describe('ingestSapiraQuantities', () => {
		it('persiste el payload del DWH parseando numéricos y normalizando account vacío', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ totalFromDwh: 1, inserted: 1, updated: 0, unchanged: 0, discarded: 0 });
			const saved = quantityImportRepository.save.mock.calls[0][0];
			expect(saved).toMatchObject({
				holding_id: 'holding-1',
				sf_id: '0015w00002sxiepAAA',
				period: '2026-08-01',
				quantity: '15000',
				unit_price: '0.05',
				unit_of_measure: 'Mensajes',
				currency: 'USD',
				quote_line_id: '0QLRO00000INNuP4AX',
				opportunity_id: '006RO00000c2p8bYAA',
				integration_status: 'pending',
			});
			// account llega como cadena vacía desde el DWH y debe guardarse como NULL
			expect(saved.account).toBeNull();
		});

		it('ingesta también las filas sin IDs de mapeo: el descarte ocurre en la fase 2', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE, DWH_ROW_SIN_IDS]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ totalFromDwh: 2, inserted: 2, discarded: 0 });
		});

		it('normaliza el período al primer día del mes cuando billing_date cae a mitad de mes', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[{ ...DWH_ROW_MAPEABLE, billing_date: { value: '2026-08-17' } }]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			await service.ingestSapiraQuantities('holding-1');

			expect(quantityImportRepository.save.mock.calls[0][0]).toMatchObject({ billing_date: '2026-08-17', period: '2026-08-01' });
		});

		it('trunca unit a 32 caracteres para respetar quantities.unit_of_measure', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[{ ...DWH_ROW_MAPEABLE, unit: 'M'.repeat(40) }]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			await service.ingestSapiraQuantities('holding-1');

			expect(quantityImportRepository.save.mock.calls[0][0].unit_of_measure).toHaveLength(32);
		});

		it('persiste como no_quantity_data las filas sin quantity ni unit_price, para vigilarlas', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[{ ...DWH_ROW_MAPEABLE, quantity: null, unit_price: null }]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			const result = await service.ingestSapiraQuantities('holding-1');

			// No son integrables, pero se guardan para detectar cambios en el origen: es el rol
			// que absorbió de sapira_base_records.
			expect(result).toMatchObject({ inserted: 1, noQuantityData: 1, discarded: 0 });
			expect(quantityImportRepository.save.mock.calls[0][0].integration_status).toBe('no_quantity_data');
		});

		it('descarta solo las filas sin clave natural', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[{ ...DWH_ROW_MAPEABLE, sf_id: null }]]),
			} as any);

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ discarded: 1, inserted: 0 });
			expect(quantityImportRepository.save).not.toHaveBeenCalled();
		});

		it('guarda los campos que no se integran, para detectar cambios en el origen', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_SIN_IDS]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(null);

			await service.ingestSapiraQuantities('holding-1');

			expect(quantityImportRepository.save.mock.calls[0][0]).toMatchObject({
				entity_name: 'A.G.N. GUIMARAES COMERCIO ATACADO E VAREJO DE GENEROS ALIMENTICIOS LTDA',
				tin: '00.965.070/0001-84',
				country: 'Brasil',
			});
		});

		it('un cambio solo en un campo no integrable también dispara el diff', async () => {
			const { service, quantityImportRepository, notificationsService } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(
				buildImport({ source_hash: 'hash-viejo', integration_status: 'integrated', quantity_id: 'quantity-1', country: 'Chile' })
			);

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ changedInSource: 1 });
			const diff = notificationsService.createOrUpdate.mock.calls[0][1];
			expect(diff.metadata.differences).toEqual(
				expect.arrayContaining([expect.objectContaining({ field: 'country', current: 'Chile', incoming: 'Peru' })])
			);
		});

		it('no reporta diff cuando el DWH cambia el formato de un numérico sin cambiar el valor', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[{ ...DWH_ROW_MAPEABLE, unit_price: '0.050' }]]),
			} as any);
			// El hash se calcula sobre el valor parseado, así que '0.050' y '0.05' colisionan.
			const hash = (service as any).normalizeQuantityRow(DWH_ROW_MAPEABLE).source_hash;
			quantityImportRepository.findOne.mockResolvedValue(buildImport({ source_hash: hash }));

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ unchanged: 1, changedInSource: 0, updated: 0 });
		});

		it('es idempotente cuando el payload del DWH no cambió', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE]]),
			} as any);
			const hash = (service as any).normalizeQuantityRow(DWH_ROW_MAPEABLE).source_hash;
			quantityImportRepository.findOne.mockResolvedValue(buildImport({ source_hash: hash }));

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ unchanged: 1, inserted: 0, updated: 0 });
			expect(quantityImportRepository.save).not.toHaveBeenCalled();
		});

		it('vuelve a pending una fila no integrada cuyo payload cambió en el origen', async () => {
			const { service, quantityImportRepository } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(buildImport({ source_hash: 'hash-viejo', integration_status: 'unmapped' }));

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ updated: 1, changedInSource: 0 });
			expect(quantityImportRepository.save.mock.calls[0][0]).toMatchObject({ integration_status: 'pending', quantity: '15000' });
		});

		it('marca changed_in_source y notifica cuando el DWH cambia una fila ya integrada, sin tocar quantities', async () => {
			const { service, quantityImportRepository, notificationsService, dataSource } = buildService();
			jest.spyOn(service, 'getBigQueryClientForHolding').mockResolvedValue({
				query: jest.fn().mockResolvedValue([[DWH_ROW_MAPEABLE]]),
			} as any);
			quantityImportRepository.findOne.mockResolvedValue(
				buildImport({ source_hash: 'hash-viejo', integration_status: 'integrated', quantity_id: 'quantity-1' })
			);

			const result = await service.ingestSapiraQuantities('holding-1');

			expect(result).toMatchObject({ changedInSource: 1, updated: 0 });
			expect(quantityImportRepository.save.mock.calls[0][0].integration_status).toBe('changed_in_source');
			expect(dataSource.query).not.toHaveBeenCalled();
			expect(notificationsService.createOrUpdate).toHaveBeenCalledTimes(1);
			expect(notificationsService.createOrUpdate.mock.calls[0][1].type).toBe('bigquery_quantities_diff');
		});
	});

	describe('integrateSapiraQuantities', () => {
		it('mapea por quote_line_id e inserta en quantities sin amount ni holding_id', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport()]);
			wireDataSource(dataSource, { candidates: [buildCandidate()] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ integrated: 1, unmapped: 0, blocked: 0, conflict: 0 });

			const insertCall = dataSource.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO quantities'));
			expect(insertCall).toBeDefined();
			// amount lo llena otro canal y ganaría al COALESCE del trigger de RSM;
			// holding_id lo deriva trg_quantities_set_holding.
			expect(insertCall[0]).not.toMatch(/\bamount\b/);
			expect(insertCall[0]).not.toMatch(/\bholding_id\b/);
			expect(insertCall[1]).toEqual([
				CONTRACT_ITEM_ID,
				CONTRACT_ID,
				'2026-08-01',
				'0.05',
				'15000',
				'Mensajes',
				null,
				'006RO00000c2p8bYAA',
				'0QLRO00000INNuP4AX',
				'DWH sapira_base · sf_id=0015w00002sxiepAAA',
			]);
			expect(quantityImportRepository.save.mock.calls[0][0]).toMatchObject({
				integration_status: 'integrated',
				resolution_source: 'salesforce_ids',
				quantity_id: 'quantity-1',
			});
		});

		it('prioriza el par Sapira sobre el par Salesforce cuando el DWH lo trae', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport({ sapira_contract_item_id: CONTRACT_ITEM_ID })]);
			wireDataSource(dataSource, { candidates: [buildCandidate()] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ integrated: 1 });
			expect(quantityImportRepository.save.mock.calls[0][0].resolution_source).toBe('sapira_ids');
		});

		it('deja unmapped la fila del DWH que no trae ninguno de los cuatro IDs', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([
				buildImport({ id: 'import-2', sf_id: '001RO00000DkSLBYA3', quote_line_id: null, opportunity_id: null }),
			]);
			wireDataSource(dataSource, { candidates: [] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ unmapped: 1, integrated: 0 });
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO quantities'))).toBe(false);
			expect(quantityImportRepository.save.mock.calls[0][0]).toMatchObject({
				integration_status: 'unmapped',
				integration_reason: expect.stringContaining('no es mapeable'),
			});
		});

		it('acota la búsqueda de contract_items al holding (guard de tenancy sin RLS)', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport()]);
			wireDataSource(dataSource, { candidates: [buildCandidate()] });

			await service.integrateSapiraQuantities('holding-1');

			const resolveCall = dataSource.query.mock.calls.find(([sql]) => sql.includes('FROM contract_items'));
			expect(resolveCall[0]).toContain('ci.holding_id = $1');
			expect(resolveCall[1][0]).toBe('holding-1');
		});

		it('descarta ítems que no son variables', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport()]);
			wireDataSource(dataSource, { candidates: [buildCandidate({ quantity: '0' })] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ notVariable: 1, integrated: 0 });
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO quantities'))).toBe(false);
		});

		it('descarta filas cuya moneda difiere de la del contrato', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport({ currency: 'BRL' })]);
			wireDataSource(dataSource, { candidates: [buildCandidate({ item_currency: 'USD' })] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ currencyMismatch: 1, integrated: 0 });
			expect(quantityImportRepository.save.mock.calls[0][0].integration_reason).toContain('BRL');
		});

		it('marca ambiguas dos filas que apuntan al mismo ítem y período con valores distintos', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([
				buildImport({ id: 'import-1', quantity: '15000' }),
				buildImport({ id: 'import-2', quantity: '99999' }),
			]);
			wireDataSource(dataSource, { candidates: [buildCandidate()] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ ambiguous: 2, integrated: 0 });
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO quantities'))).toBe(false);
		});

		it('es idempotente cuando ya existe un override idéntico', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport()]);
			wireDataSource(dataSource, {
				candidates: [buildCandidate()],
				existingQuantities: {
					[`${CONTRACT_ITEM_ID}|2026-08-01`]: [
						{ id: 'quantity-1', unit_price: '0.050000', quantity: '15000.000000', unit_of_measure: 'Mensajes', account: null },
					],
				},
			});

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ integrated: 1, conflict: 0 });
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO quantities'))).toBe(false);
		});

		it('marca conflict y notifica cuando ya existe un override con valores distintos, sin sobrescribir', async () => {
			const { service, quantityImportRepository, dataSource, notificationsService } = buildService();
			quantityImportRepository.find.mockResolvedValue([buildImport()]);
			wireDataSource(dataSource, {
				candidates: [buildCandidate()],
				existingQuantities: {
					[`${CONTRACT_ITEM_ID}|2026-08-01`]: [
						{ id: 'quantity-1', unit_price: '0.050000', quantity: '999.000000', unit_of_measure: 'Mensajes', account: null },
					],
				},
			});

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ conflict: 1, integrated: 0 });
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO quantities'))).toBe(false);
			expect(dataSource.query.mock.calls.some(([sql]) => sql.includes('UPDATE quantities'))).toBe(false);

			const diff = notificationsService.createOrUpdate.mock.calls.find(([, dto]) => dto.type === 'bigquery_quantities_diff');
			expect(diff[1].action_type).toBe('replace_quantity_record');
			expect(diff[1].action_payload.quantity_id).toBe('quantity-1');
		});

		it('aísla el error del trigger de estado de factura y sigue integrando el resto del batch', async () => {
			const { service, quantityImportRepository, dataSource } = buildService();
			const otroItem = '33333333-3333-4333-8333-333333333333';
			quantityImportRepository.find.mockResolvedValue([
				buildImport({ id: 'import-1' }),
				buildImport({ id: 'import-2', sf_id: 'sf-2', quote_line_id: 'QLI-2' }),
			]);
			wireDataSource(dataSource, {
				candidates: [buildCandidate(), buildCandidate({ id: otroItem, quote_item_number: 'QLI-2' })],
				onInsert: (params) => {
					if (params[0] === CONTRACT_ITEM_ID) {
						return Promise.reject(
							new Error('No se puede modificar el override del período 2026-08: la factura FAC-1 está en estado "Emitida".')
						);
					}
					return Promise.resolve([{ id: 'quantity-2' }]);
				},
			});

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ blocked: 1, integrated: 1 });
			const blocked = quantityImportRepository.save.mock.calls.find(([row]) => row.integration_status === 'blocked');
			expect(blocked[0].integration_reason).toContain('Emitida');
		});

		it('agrupa los no mapeados en una sola notificación en vez de una por fila', async () => {
			const { service, quantityImportRepository, dataSource, notificationsService } = buildService();
			quantityImportRepository.find.mockResolvedValue([
				buildImport({ id: 'import-1', quote_line_id: null, opportunity_id: null }),
				buildImport({ id: 'import-2', quote_line_id: null, opportunity_id: null }),
				buildImport({ id: 'import-3', quote_line_id: null, opportunity_id: null }),
			]);
			wireDataSource(dataSource, { candidates: [] });

			const result = await service.integrateSapiraQuantities('holding-1');

			expect(result).toMatchObject({ unmapped: 3 });
			const unmappedNotifications = notificationsService.createOrUpdate.mock.calls.filter(
				([, dto]) => dto.type === 'bigquery_quantities_unmapped'
			);
			expect(unmappedNotifications).toHaveLength(1);
			expect(unmappedNotifications[0][1].metadata.count).toBe(3);
		});

		it('con retryFailed incluye los estados recuperables además de pending', async () => {
			const { service, quantityImportRepository } = buildService();
			quantityImportRepository.find.mockResolvedValue([]);

			await service.integrateSapiraQuantities('holding-1', { retryFailed: true });

			const where = quantityImportRepository.find.mock.calls[0][0].where;
			expect(where.integration_status._value).toEqual(['pending', 'unmapped', 'not_variable', 'currency_mismatch', 'blocked']);
		});

		it('lanza BadRequestException cuando falta el holdingId', async () => {
			const { service } = buildService();

			await expect(service.integrateSapiraQuantities('')).rejects.toBeInstanceOf(BadRequestException);
		});
	});

	describe('replaceQuantityRecord', () => {
		it('aplica los valores del DWH, marca la importación e ignora amount', async () => {
			const { service, quantityImportRepository, dataSource, notificationsService } = buildService();
			wireDataSource(dataSource, {
				existingQuantities: { 'quantity-1|holding-1': [{ id: 'quantity-1', unit_price: '0.05', quantity: '1' }] },
			});
			quantityImportRepository.find.mockResolvedValue([buildImport({ quantity_id: 'quantity-1' })]);

			await service.replaceQuantityRecord('holding-1', 'quantity-1', { unit_price: 0.07, quantity: 20000 } as any);

			const updateCall = dataSource.query.mock.calls.find(([sql]) => sql.includes('UPDATE quantities'));
			expect(updateCall[0]).not.toMatch(/\bamount\b/);
			expect(updateCall[1]).toEqual(['quantity-1', 'holding-1', 0.07, 20000, null, null]);
			expect(quantityImportRepository.save.mock.calls[0][0].integration_status).toBe('integrated');
			expect(notificationsService.resolveByDeduplicationKey).toHaveBeenCalled();
		});

		it('lanza NotFoundException cuando el override no pertenece al holding', async () => {
			const { service, dataSource } = buildService();
			wireDataSource(dataSource, { existingQuantities: {} });

			await expect(service.replaceQuantityRecord('holding-1', 'quantity-x', {} as any)).rejects.toBeInstanceOf(NotFoundException);
		});

		it('lanza BadRequestException cuando falta el holdingId', async () => {
			const { service } = buildService();

			await expect(service.replaceQuantityRecord('', 'quantity-1', {} as any)).rejects.toBeInstanceOf(BadRequestException);
		});
	});
});

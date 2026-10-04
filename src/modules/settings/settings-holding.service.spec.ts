import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from './fake-db.testing-spec';
import { SettingsHoldingService } from './settings-holding.service';
import { SettingsStorageService } from './settings-storage.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const RATE_ID = '44444444-4444-4444-8444-444444444444';
const PUBLIC = 'https://sb.example/storage/v1/object/public/company-logos/';

const storage = {
	publicUrl: (path: string) => `${PUBLIC}${path}`,
	publicPrefix: (folder: string) => `${PUBLIC}${folder}/`,
	createUploadUrl: jest.fn(async () => ({ signedUrl: 'https://signed', token: 'tok' })),
} as unknown as SettingsStorageService;

const currencies: Handler = ['FROM currencies', (params) => (['USD', 'CLP', 'EUR'].includes(String(params[0])) ? [{ code: params[0] }] : [])];
const holdingRow: Handler = [
	'FROM company_holdings h',
	(params) =>
		params[0] === HOLDING
			? [
					{
						id: HOLDING,
						name: 'Hanka',
						website: null,
						phone: null,
						email: null,
						logo_url: null,
						users_count: '4',
						last_activity_at: '2026-10-02T12:00:00Z',
					},
				]
			: [],
];

function build(handlers: Handler[] = []) {
	const db = fakeDb([...handlers, currencies, holdingRow]);

	return { db, service: new SettingsHoldingService(db as unknown as DataSource, storage) };
}

describe('SettingsHoldingService', () => {
	describe('holding', () => {
		it('holding inexistente → 404', async () => {
			const { service } = build();

			await expect(service.getHolding('otro')).rejects.toBeInstanceOf(NotFoundException);
		});

		it('resumen: miembros activos sin super admins y su último acceso', async () => {
			const { db, service } = build();
			const holding = await service.getHolding(HOLDING);
			const [read] = db.statements('FROM company_holdings h');

			expect(holding).toMatchObject({ name: 'Hanka', users_count: 4, last_activity_at: '2026-10-02T12:00:00Z' });
			expect(read.sql).toContain('uh.is_active = true AND COALESCE(u.is_super_admin, false) = false');
			expect(read.sql).toContain('max(u.last_access)');
		});

		it('PATCH solo escribe los campos enviados y nunca el nombre', async () => {
			const { db, service } = build();

			await service.updateHolding(HOLDING, { website: 'https://hanka.cl', email: null });
			const [update] = db.statements('UPDATE company_holdings');

			expect(update.sql).toContain('SET website = $2, email = $3 WHERE id = $1');
			expect(update.params).toEqual([HOLDING, 'https://hanka.cl', null]);
			expect(update.sql).not.toContain('name');
		});

		it('logo_url ajeno al bucket o a la carpeta del holding → 400; la URL de logo-upload pasa', async () => {
			const { service } = build([['UPDATE company_holdings', () => [{ id: HOLDING, name: 'Hanka' }]]]);

			await expect(service.updateHolding(HOLDING, { logo_url: 'https://evil.example/logo.png' })).rejects.toThrow(
				'El logo debe subirse con "Subir logo"'
			);
			await expect(service.updateHolding(HOLDING, { logo_url: `${PUBLIC}holdings/otro/x.png` })).rejects.toBeInstanceOf(BadRequestException);
			await expect(service.updateHolding(HOLDING, { logo_url: `${PUBLIC}holdings/${HOLDING}/x.png` })).resolves.toBeDefined();
		});

		it('logo-upload valida tipo y tamaño y firma en la carpeta del holding', async () => {
			const { service } = build();

			await expect(service.prepareLogoUpload(HOLDING, { file_name: 'a.gif', mime_type: 'image/gif', size: 10 })).rejects.toThrow(
				'El logo debe ser PNG, JPG o WEBP'
			);
			await expect(service.prepareLogoUpload(HOLDING, { file_name: 'a.svg', mime_type: 'image/svg+xml', size: 10 })).rejects.toThrow(
				'El logo debe ser PNG, JPG o WEBP'
			);
			await expect(service.prepareLogoUpload(HOLDING, { file_name: 'a.png', mime_type: 'image/png', size: 3 * 1024 * 1024 })).rejects.toThrow(
				'El logo no puede superar 2 MB'
			);
			const upload = await service.prepareLogoUpload(HOLDING, { file_name: 'a.png', mime_type: 'image/png', size: 100 });

			expect(upload.path).toMatch(new RegExp(`^holdings/${HOLDING}/[0-9a-f-]{36}\\.png$`));
			expect(upload.public_url).toBe(`${PUBLIC}${upload.path}`);
		});
	});

	describe('preferencias', () => {
		it('sin fila devuelve los valores por defecto', async () => {
			const { service } = build();

			const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric' }).format(new Date());

			await expect(service.getPreferences(HOLDING)).resolves.toEqual({
				system_currency: 'USD',
				fx_system_policy: 'monthly_avg',
				auto_renewal_notice_days: 30,
				locked: false,
				locked_reason: null,
				// Ronda 4: defaults = comportamiento anterior.
				timezone: 'America/Santiago',
				renewal_reminder_days: [15, 7, 0],
				renewal_overdue_every_days: 7,
				renewal_reminder_ladder: [30, 15, 7, 0],
				quote_numbering: { mode: 'prefixed', prefix: 'COT', include_year: true, width: 4, next_number_preview: `COT-${year}-0001` },
			});
		});

		it('upsert con la moneda validada en mayúsculas; moneda desconocida → 400', async () => {
			const { db, service } = build();

			await expect(service.updatePreferences(HOLDING, { system_currency: 'xxx' })).rejects.toThrow('Moneda no reconocida: XXX');
			await service.updatePreferences(HOLDING, { system_currency: 'clp', fx_system_policy: 'fixed_period' });
			expect(db.statements('INSERT INTO holding_settings')[0].params).toEqual([
				HOLDING,
				'CLP',
				'fixed_period',
				30,
				'America/Santiago',
				[15, 7, 0],
				7,
				'prefixed',
				'COT',
				true,
				4,
			]);
		});
	});

	describe('preferencias de la ronda 4 (zona horaria, recordatorios, numeración de cotizaciones)', () => {
		const stored: Handler = [
			'to_jsonb(hs)',
			() => [
				{
					settings: {
						auto_renewal_notice_days: 90,
						timezone: 'America/Lima',
						renewal_reminder_days: [45, 20, 0],
						renewal_overdue_every_days: 14,
						quote_numbering_mode: 'prefixed',
						quote_number_prefix: 'PROP',
						quote_number_include_year: false,
						quote_number_width: 5,
					},
				},
			],
		];
		const lastQuote: Handler = ['regexp_match(quote_number', (params) => [{ next: params[1] === '^PROP-(\\d{1,12})$' ? 13 : 1 }]];

		it('GET: lee lo guardado, la escalera efectiva del job y la vista previa del próximo número', async () => {
			const { service } = build([stored, lastQuote]);
			const result = await service.getPreferences(HOLDING);

			expect(result).toMatchObject({
				timezone: 'America/Lima',
				renewal_reminder_days: [45, 20, 0],
				renewal_overdue_every_days: 14,
				renewal_reminder_ladder: [90, 45, 20, 0],
				quote_numbering: { mode: 'prefixed', prefix: 'PROP', include_year: false, width: 5, next_number_preview: 'PROP-00013' },
			});
		});

		it('GET: modo manual sin vista previa; valores inválidos guardados caen al default', async () => {
			const odd: Handler = ['to_jsonb(hs)', () => [{ settings: { timezone: 'Mars/Base', quote_numbering_mode: 'manual' } }]];
			const result = await build([odd]).service.getPreferences(HOLDING);

			expect(result.timezone).toBe('America/Santiago');
			expect(result.quote_numbering).toMatchObject({ mode: 'manual', next_number_preview: null });
		});

		it('PATCH: guarda zona, escalera ordenada de mayor a menor y numeración mezclada con lo guardado', async () => {
			const { db, service } = build([stored, lastQuote]);

			await service.updatePreferences(HOLDING, {
				timezone: 'America/Mexico_City',
				renewal_reminder_days: [0, 30, 7],
				quote_numbering: { mode: 'sequential' },
			});
			expect(db.statements('INSERT INTO holding_settings')[0].params).toEqual([
				HOLDING,
				'USD',
				'monthly_avg',
				90,
				'America/Mexico_City',
				[30, 7, 0],
				14,
				'sequential',
				'PROP',
				false,
				5,
			]);
		});

		it('PATCH: zona horaria desconocida → 400 con el campo', async () => {
			const { db, service } = build();

			await expect(service.updatePreferences(HOLDING, { timezone: 'America/Gotham' })).rejects.toThrow(
				'Zona horaria no reconocida: America/Gotham'
			);
			expect(db.statements('INSERT INTO holding_settings')).toHaveLength(0);
		});

		it('con contratos, las preferencias de la ronda 4 se pueden cambiar (rigen hacia adelante)', async () => {
			const withContracts: Handler = ['FROM contracts WHERE holding_id = $1', () => [{ '?column?': 1 }]];
			const { db, service } = build([withContracts]);

			await service.updatePreferences(HOLDING, { timezone: 'UTC', renewal_overdue_every_days: 30 });
			expect(db.statements('INSERT INTO holding_settings')).toHaveLength(1);
		});
	});

	describe('moneda de consolidación y política de tipo de cambio', () => {
		const withContracts: Handler = ['FROM contracts WHERE holding_id = $1', () => [{ '?column?': 1 }]];

		it('GET con contratos: locked y el motivo para el front', async () => {
			const { service } = build([withContracts]);

			await expect(service.getPreferences(HOLDING)).resolves.toMatchObject({
				locked: true,
				locked_reason: expect.stringContaining('El holding ya tiene contratos'),
			});
		});

		it('con contratos: cambiar la moneda → 409 y no escribe; misma moneda u otros campos sí se guardan', async () => {
			const { db, service } = build([withContracts]);

			await expect(service.updatePreferences(HOLDING, { system_currency: 'CLP' })).rejects.toThrow(
				new ConflictException(
					'No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas'
				)
			);
			expect(db.statements('INSERT INTO holding_settings')).toHaveLength(0);
			await service.updatePreferences(HOLDING, { system_currency: 'usd', fx_system_policy: 'monthly_avg', auto_renewal_notice_days: 45 });
			expect(db.statements('INSERT INTO holding_settings')[0].params).toEqual([
				HOLDING,
				'USD',
				'monthly_avg',
				45,
				'America/Santiago',
				[15, 7, 0],
				7,
				'prefixed',
				'COT',
				true,
				4,
			]);
		});

		it('con contratos: cambiar la política de tipo de cambio → 409 con su propio mensaje', async () => {
			const { db, service } = build([withContracts]);

			await expect(service.updatePreferences(HOLDING, { fx_system_policy: 'fixed_period' })).rejects.toThrow(
				new ConflictException(
					'No se puede cambiar la política de tipo de cambio: el holding ya tiene contratos y cambiaría todas las métricas históricas'
				)
			);
			expect(db.statements('INSERT INTO holding_settings')).toHaveLength(0);
		});

		it('sin contratos se pueden cambiar las dos', async () => {
			const { db, service } = build();
			const result = await service.updatePreferences(HOLDING, { system_currency: 'EUR', fx_system_policy: 'fixed_period' });

			expect(db.statements('INSERT INTO holding_settings')[0].params.slice(1, 3)).toEqual(['EUR', 'fixed_period']);
			expect(result.locked).toBe(false);
		});
	});

	describe('tasas fijas por período', () => {
		const base = { from_currency: 'CLP', to_currency: 'USD', rate: 0.001, period_start: '2026-01-01', period_end: '2026-03-31' };

		it('monedas iguales, tasa ≤ 0 o fin antes del inicio → 400', async () => {
			const { service } = build();

			await expect(service.createFxRate(HOLDING, { ...base, to_currency: 'CLP' }, null)).rejects.toThrow('deben ser distintas');
			await expect(service.createFxRate(HOLDING, { ...base, rate: 0 }, null)).rejects.toThrow('mayor que cero');
			await expect(service.createFxRate(HOLDING, { ...base, period_end: '2025-12-31' }, null)).rejects.toThrow('igual o posterior');
		});

		it('período que se cruza con otro del mismo par → 409 con las fechas', async () => {
			const { db, service } = build([
				[
					'FROM holding_fx_period_rates WHERE holding_id = $1 AND from_currency',
					() => [{ period_start: '2026-02-01', period_end: '2026-02-28' }],
				],
			]);

			await expect(service.createFxRate(HOLDING, base, null)).rejects.toThrow(
				new ConflictException('Ya hay una tasa CLP→USD que se cruza con ese período (01-02-2026 a 28-02-2026)')
			);
			expect(db.statements('INSERT INTO holding_fx_period_rates')).toHaveLength(0);
		});

		it('crea con quién la creó y devuelve la fila', async () => {
			const { db, service } = build([
				['INSERT INTO holding_fx_period_rates', () => [{ id: RATE_ID }]],
				['WHERE r.id = $1 AND r.holding_id = $2', () => [{ id: RATE_ID, ...base, rate: '0.001', created_by_name: 'Ana' }]],
			]);
			const rate = await service.createFxRate(HOLDING, base, 'user-1');

			expect(db.statements('INSERT INTO holding_fx_period_rates')[0].params).toEqual([
				HOLDING,
				'CLP',
				'USD',
				0.001,
				'2026-01-01',
				'2026-03-31',
				null,
				'user-1',
			]);
			expect(rate).toMatchObject({ id: RATE_ID, rate: 0.001, created_by_name: 'Ana' });
		});

		it('tasa proyectada (04-10): crear recalcula en la misma transacción v2 el devengo y las facturas desde su período', async () => {
			const { db, service } = build([
				['INSERT INTO holding_fx_period_rates', () => [{ id: RATE_ID }]],
				['WHERE r.id = $1 AND r.holding_id = $2', () => [{ id: RATE_ID, ...base, rate: '930' }]],
				['FROM holding_settings WHERE holding_id = $1', () => [{ system_currency: 'USD', fx_system_policy: 'fixed_period' }]],
				['FROM contracts c WHERE c.holding_id = $1', () => [{ id: 'c-1', from_month: '2026-01-01' }]],
			]);
			const rate = await service.createFxRate(HOLDING, { ...base, rate: 930 }, null);
			const order = db.calls.map((call) => call.sql);
			const writer = order.findIndex((sql) => sql.includes(`set_config('sapira.writer', 'api', true)`));

			expect(writer).toBeGreaterThanOrEqual(0);
			expect(writer).toBeLessThan(order.findIndex((sql) => sql.includes('INSERT INTO holding_fx_period_rates')));
			expect(db.statements('revenue_schedule_apply_fx_for_contract')[0].params).toEqual(['c-1', '2026-01-01']);
			expect(db.committed()).toBe(1);
			expect(rate.recalculated).toEqual({ from_month: '2026-01-01', contracts: 1, invoices: 0 });
		});

		it('editar recalcula desde el menor de los dos inicios y con las monedas de antes y de ahora; borrar desde su inicio', async () => {
			const { db, service } = build([
				['WHERE r.id = $1 AND r.holding_id = $2', () => [{ id: RATE_ID, ...base, period_start: '2027-01-01', period_end: '2027-12-31' }]],
				['FROM holding_settings WHERE holding_id = $1', () => [{ system_currency: 'USD', fx_system_policy: 'fixed_period' }]],
			]);

			await service.updateFxRate(HOLDING, RATE_ID, { from_currency: 'EUR', period_start: '2026-07-01' });
			const [contracts] = db.statements('FROM contracts c WHERE c.holding_id = $1');

			expect(contracts.params).toEqual([HOLDING, ['CLP', 'EUR'], '2026-07-01']);
			await service.deleteFxRate(HOLDING, RATE_ID);
			expect(db.statements('FROM contracts c WHERE c.holding_id = $1')[1].params).toEqual([HOLDING, ['CLP'], '2027-01-01']);
			expect(db.statements('DELETE FROM holding_fx_period_rates')).toHaveLength(1);
		});

		it('editar o borrar una tasa de otro holding → 404', async () => {
			const { service } = build();

			await expect(service.updateFxRate(HOLDING, RATE_ID, { rate: 2 })).rejects.toThrow('Tasa no encontrada');
			await expect(service.deleteFxRate(HOLDING, RATE_ID)).rejects.toBeInstanceOf(NotFoundException);
		});

		it('al editar, el cruce excluye la propia tasa', async () => {
			const { db, service } = build([['WHERE r.id = $1 AND r.holding_id = $2', () => [{ id: RATE_ID, ...base, rate: '0.001' }]]]);

			await service.updateFxRate(HOLDING, RATE_ID, { rate: 0.002 });
			const overlap = db.statements('id IS DISTINCT FROM $4::uuid')[0];

			expect(overlap.params[3]).toBe(RATE_ID);
			expect(db.statements('UPDATE holding_fx_period_rates')[0].params).toContain(0.002);
		});
	});

	describe('sincronización y árbol', () => {
		it('una fila por moneda en uso (sin USD), con la última carga no "system"', async () => {
			const { db, service } = build([
				['SELECT DISTINCT upper(code)', () => [{ code: 'CLP' }, { code: 'GBP' }, { code: 'USD' }]],
				[
					'FROM exchange_rates',
					() => [
						{
							to_currency: 'CLP',
							rate_date: '2026-10-01',
							rate: '943.1',
							source_type: 'BANCOCENTRAL',
							api_source: 'Banco Central de Chile',
						},
					],
				],
			]);
			const status = await service.fxSyncStatus(HOLDING);

			expect(db.statements('FROM exchange_rates')[0].sql).toContain("source_type <> 'system'");
			expect(status.currencies.map((row) => [row.currency, row.pair, row.source_label])).toEqual([
				['CLP', 'USD/CLP', 'Banco Central de Chile'],
				['GBP', 'USD/GBP', null],
			]);
		});

		it('árbol con chips por compañía', async () => {
			const { db, service } = build([
				[
					'FROM companies c LEFT JOIN accounting_period_cutoff',
					() => [
						{
							id: 'c1',
							legal_name: 'Hanka SpA',
							country_code: 'CL',
							country: 'Chile',
							currency: 'CLP',
							cutoff_date: '2026-07-31',
							accounts_complete: false,
							sii_configured: true,
							odoo_integration_id: 7,
						},
					],
				],
			]);
			const tree = await service.tree(HOLDING);

			expect(tree.holding).toMatchObject({ name: 'Hanka', system_currency: 'USD' });
			expect(tree.companies[0]).toMatchObject({ closed_until: '2026-07-31', accounts_complete: false, sii_configured: true, erp_linked: true });
			expect(db.statements('FROM companies c LEFT JOIN accounting_period_cutoff')[0].sql).toContain(
				"NULLIF(btrim(m.fx_difference_account_name), '') IS NOT NULL"
			);
		});
	});
});

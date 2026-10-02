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
	'FROM company_holdings WHERE id',
	(params) => (params[0] === HOLDING ? [{ id: HOLDING, name: 'Hanka', website: null, phone: null, email: null, logo_url: null }] : []),
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

		it('PATCH solo escribe los campos enviados', async () => {
			const { db, service } = build([['UPDATE company_holdings', () => [{ id: HOLDING, name: 'Hanka 2' }]]]);

			await service.updateHolding(HOLDING, { name: 'Hanka 2', email: null });
			const [update] = db.statements('UPDATE company_holdings');

			expect(update.sql).toContain('SET name = $2, email = $3 WHERE id = $1');
			expect(update.params).toEqual([HOLDING, 'Hanka 2', null]);
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
				'El logo debe ser PNG, JPG, WEBP o SVG'
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

			await expect(service.getPreferences(HOLDING)).resolves.toEqual({
				system_currency: 'USD',
				fx_system_policy: 'monthly_avg',
				auto_renewal_notice_days: 30,
			});
		});

		it('upsert con la moneda validada en mayúsculas; moneda desconocida → 400', async () => {
			const { db, service } = build();

			await expect(service.updatePreferences(HOLDING, { system_currency: 'xxx' })).rejects.toThrow('Moneda no reconocida: XXX');
			await service.updatePreferences(HOLDING, { system_currency: 'clp', fx_system_policy: 'fixed_period' });
			expect(db.statements('INSERT INTO holding_settings')[0].params).toEqual([HOLDING, 'CLP', 'fixed_period', 30]);
		});
	});

	describe('moneda de consolidación', () => {
		it('con contratos → 409 y no escribe; misma moneda u otros campos sí se guardan', async () => {
			const { db, service } = build([['FROM contracts WHERE holding_id = $1', () => [{ n: '3' }]]]);

			await expect(service.updatePreferences(HOLDING, { system_currency: 'CLP' })).rejects.toThrow(
				new ConflictException(
					'No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas'
				)
			);
			expect(db.statements('INSERT INTO holding_settings')).toHaveLength(0);
			await service.updatePreferences(HOLDING, { system_currency: 'usd', auto_renewal_notice_days: 45 });
			expect(db.statements('INSERT INTO holding_settings')[0].params).toEqual([HOLDING, 'USD', 'monthly_avg', 45]);
		});

		it('sin contratos se puede cambiar', async () => {
			const { db, service } = build([['FROM contracts WHERE holding_id = $1', () => [{ n: 0 }]]]);

			await service.updatePreferences(HOLDING, { system_currency: 'EUR' });
			expect(db.statements('INSERT INTO holding_settings')[0].params[1]).toBe('EUR');
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
			const { service } = build([
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
		});
	});
});

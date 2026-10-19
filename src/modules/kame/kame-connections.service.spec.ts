import { EncryptionService } from '@/common/services/encryption.service';

import { businessUnitNames, KameConnectionsService } from './kame-connections.service';

import type { KameClientService } from './kame-client.service';
import type { ConfigService } from '@nestjs/config';

const HOLDING = 'holding-1';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const encryption = new EncryptionService({ get: () => 'clave-de-prueba' } as unknown as ConfigService);

type Row = Record<string, unknown>;

/** Base en memoria mínima: responde según el SQL. */
function fakeDb(state: { company?: Row | null; connections?: Row[]; settings?: Row | null; cutoff?: string | null }) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		if (sql.includes('FROM companies WHERE id = $1'))
			return state.company === null ? [] : [state.company ?? { legal_name: 'Firmare SpA', has_odoo: false, country: 'CL' }];
		if (sql.startsWith('SELECT * FROM kame_connections WHERE holding_id = $1 AND company_id')) {
			return (state.connections ?? []).filter((row) => row.environment === params[2]);
		}
		if (sql.startsWith('SELECT * FROM kame_company_settings WHERE holding_id = $1 AND company_id')) return state.settings ? [state.settings] : [];
		if (sql.includes('FROM accounting_period_cutoff')) return state.cutoff ? [{ month: state.cutoff }] : [];
		if (sql.startsWith('INSERT INTO kame_connections')) {
			const [holding_id, company_id, environment, client_id, client_secret_encrypted, user_email, kame_company_rut, business_unit, branch] =
				params;
			state.connections = [
				...(state.connections ?? []).filter((row) => row.environment !== environment),
				{
					id: 'conn-1',
					holding_id,
					company_id,
					environment,
					client_id,
					client_secret_encrypted,
					user_email,
					kame_company_rut,
					business_unit,
					branch,
					tested_at: null,
					test_error: null,
				},
			];

			return [];
		}
		if (sql.startsWith('INSERT INTO kame_company_settings')) {
			const [company_id, , active_environment, enabled, send_invoices, send_journal, dry_run, invoices_from, journal_from] = params;
			state.settings = { company_id, active_environment, enabled, send_invoices, send_journal, dry_run, invoices_from, journal_from };

			return [];
		}
		if (sql.startsWith('UPDATE kame_connections SET tested_at')) {
			state.connections = (state.connections ?? []).map((row) =>
				row.id === params[0] ? { ...row, tested_at: params[1] ? row.tested_at : new Date(), test_error: params[1] } : row
			);

			return [];
		}

		return [];
	});

	return { dataSource: { query } as never, calls, state };
}

const client = () =>
	({
		listBusinessUnits: jest.fn(async () => [{ Nombre: 'CASA MATRIZ' }, { Nombre: 'VENTAS' }]),
		forgetToken: jest.fn(),
	}) as unknown as KameClientService & { listBusinessUnits: jest.Mock };
const input = {
	client_id: 'abc',
	client_secret: 'secreto-1234',
	user_email: 'Conta@Empresa.cl',
	kame_company_rut: '10.491.356-3',
	business_unit: 'CASA MATRIZ',
};

describe('KameConnectionsService', () => {
	const original = process.env.KAME_ALLOWED_RUTS;

	beforeEach(() => {
		// Fuera de producción el resguardo falla cerrado sin lista: las pruebas declaran las empresas permitidas.
		process.env.KAME_ALLOWED_RUTS = '10491356-3,77307689-8';
	});

	afterEach(() => {
		if (original === undefined) delete process.env.KAME_ALLOWED_RUTS;
		else process.env.KAME_ALLOWED_RUTS = original;
	});

	it('guarda la credencial con el secret cifrado y nunca lo devuelve (solo los últimos 4)', async () => {
		const db = fakeDb({});
		const service = new KameConnectionsService(db.dataSource, encryption, client());

		const view = await service.saveConnection(HOLDING, COMPANY, 'pruebas', input, 'user-1');

		const stored = db.state.connections![0];
		expect(stored.client_secret_encrypted).not.toContain('secreto');
		expect(encryption.decrypt(String(stored.client_secret_encrypted))).toBe('secreto-1234');
		expect(stored).toMatchObject({ kame_company_rut: '10491356-3', user_email: 'conta@empresa.cl' });
		expect(view).toMatchObject({ has_secret: true, secret_last4: '1234', environment: 'pruebas' });
		expect(JSON.stringify(view)).not.toContain('secreto');
	});

	it('editar sin secret conserva el guardado; la primera vez lo exige', async () => {
		const db = fakeDb({});
		const service = new KameConnectionsService(db.dataSource, encryption, client());

		await expect(service.saveConnection(HOLDING, COMPANY, 'pruebas', { ...input, client_secret: '' }, null)).rejects.toThrow();
		await service.saveConnection(HOLDING, COMPANY, 'pruebas', input, null);
		const before = db.state.connections![0].client_secret_encrypted;
		await service.saveConnection(HOLDING, COMPANY, 'pruebas', { ...input, client_secret: undefined }, null);

		expect(db.state.connections![0].client_secret_encrypted).toBe(before);
	});

	it('fuera de producción solo acepta la empresa de pruebas (KAME_ALLOWED_RUTS)', async () => {
		process.env.KAME_ALLOWED_RUTS = '10491356-3';
		const service = new KameConnectionsService(fakeDb({}).dataSource, encryption, client());

		await expect(service.saveConnection(HOLDING, COMPANY, 'produccion', { ...input, kame_company_rut: '77.307.689-8' }, null)).rejects.toThrow();
		await expect(service.saveConnection(HOLDING, COMPANY, 'pruebas', input, null)).resolves.toMatchObject({ rut_allowed: true });
	});

	it('compañía de otro holding → 404; con Odoo → conflicto; fuera de Chile → 400', async () => {
		await expect(
			new KameConnectionsService(fakeDb({ company: null }).dataSource, encryption, client()).saveConnection(
				HOLDING,
				COMPANY,
				'pruebas',
				input,
				null
			)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			new KameConnectionsService(
				fakeDb({ company: { legal_name: 'X', has_odoo: true, country: 'CL' } }).dataSource,
				encryption,
				client()
			).saveConnection(HOLDING, COMPANY, 'pruebas', input, null)
		).rejects.toMatchObject({ status: 409 });
		await expect(
			new KameConnectionsService(
				fakeDb({ company: { legal_name: 'X', has_odoo: false, country: 'MX' } }).dataSource,
				encryption,
				client()
			).saveConnection(HOLDING, COMPANY, 'pruebas', input, null)
		).rejects.toMatchObject({ status: 400 });
	});

	it('probar la conexión lista las unidades de negocio y guarda el resultado', async () => {
		const db = fakeDb({});
		const kame = client();
		const service = new KameConnectionsService(db.dataSource, encryption, kame);

		await service.saveConnection(HOLDING, COMPANY, 'pruebas', input, null);
		const result = await service.testConnection(HOLDING, COMPANY, 'pruebas');

		expect(result).toEqual({ ok: true, message: 'Conexión con Kame correcta', business_units: ['CASA MATRIZ', 'VENTAS'] });
		expect(kame.listBusinessUnits).toHaveBeenCalledWith({ key: 'conn-1', clientId: 'abc', clientSecret: 'secreto-1234' });
		expect(db.state.connections![0].tested_at).toBeInstanceOf(Date);

		await service.saveConnection(HOLDING, COMPANY, 'pruebas', { ...input, business_unit: 'NO EXISTE' }, null);
		expect(await service.testConnection(HOLDING, COMPANY, 'pruebas')).toMatchObject({
			ok: false,
			message: 'La unidad de negocio «NO EXISTE» no existe en Kame',
		});
	});

	it('prender la conexión exige la del ambiente activo probada; las fechas de inicio se completan solas', async () => {
		const db = fakeDb({ cutoff: '2026-09-01' });
		const service = new KameConnectionsService(db.dataSource, encryption, client());

		await expect(service.updateSettings(HOLDING, COMPANY, { enabled: true }, null)).rejects.toThrow('Primero guarda la conexión de pruebas');
		await service.saveConnection(HOLDING, COMPANY, 'pruebas', input, null);
		await expect(service.updateSettings(HOLDING, COMPANY, { enabled: true }, null)).rejects.toThrow('Prueba la conexión de pruebas');
		await service.testConnection(HOLDING, COMPANY, 'pruebas');

		const settings = await service.updateSettings(HOLDING, COMPANY, { enabled: true, send_invoices: true, send_journal: true }, null);

		expect(settings).toMatchObject({
			enabled: true,
			send_invoices: true,
			send_journal: true,
			dry_run: true,
			active_environment: 'pruebas',
			journal_from: '2026-09-01',
		});
		expect(settings.invoices_from).toBe(new Date().toISOString().slice(0, 10));
	});

	it('pasar a producción exige su conexión probada, fija desde cuándo y vuelve a simulación', async () => {
		const db = fakeDb({
			cutoff: '2026-09-01',
			settings: {
				company_id: COMPANY,
				active_environment: 'pruebas',
				enabled: true,
				send_invoices: true,
				send_journal: false,
				dry_run: false,
				invoices_from: '2026-10-01',
				journal_from: null,
			},
		});
		const service = new KameConnectionsService(db.dataSource, encryption, client());

		await expect(service.switchEnvironment(HOLDING, COMPANY, { environment: 'produccion' }, null)).rejects.toThrow(
			'Primero guarda la conexión de producción'
		);
		await service.saveConnection(HOLDING, COMPANY, 'produccion', { ...input, kame_company_rut: '77307689-8' }, null);
		await service.testConnection(HOLDING, COMPANY, 'produccion');

		const settings = await service.switchEnvironment(HOLDING, COMPANY, { environment: 'produccion', invoices_from: '2026-10-20' }, null);

		expect(settings).toMatchObject({ active_environment: 'produccion', invoices_from: '2026-10-20', journal_from: '2026-09-01', dry_run: true });
		await expect(service.switchEnvironment(HOLDING, COMPANY, { environment: 'produccion' }, null)).rejects.toMatchObject({ status: 409 });
	});

	it('businessUnitNames lee la respuesta con tolerancia', () => {
		expect(businessUnitNames([{ Nombre: 'A' }, { UnidadNegocio: 'B' }, 'C', { Nombre: 'A' }, { Otro: 1 }])).toEqual(['A', 'B', 'C']);
		expect(businessUnitNames({ data: [{ descripcion: 'D' }] })).toEqual(['D']);
		expect(businessUnitNames(null)).toEqual([]);
	});
});

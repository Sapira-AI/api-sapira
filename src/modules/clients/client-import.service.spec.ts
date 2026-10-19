import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientImportService } from './client-import.service';

import type { ClientImportApplyDto } from './dtos/client-import.dto';

type Impl = (sql: string, params: unknown[]) => unknown;

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ACME = {
	id: 'c-acme',
	name_commercial: 'Acme',
	segment: 'Enterprise',
	industry: null,
	market: 'Latam',
	country: 'Chile',
	country_code: 'CL',
	client_since: null,
	notes: null,
};
const BETA = {
	id: 'c-beta',
	name_commercial: 'Beta',
	segment: null,
	industry: null,
	market: null,
	country: null,
	country_code: null,
	client_since: '2024-03-01',
	notes: 'vip',
};

/** `dataSource.query` (lecturas) y un runner de transacción (escrituras). `impl` responde según el SQL. */
const build = (impl: Impl, txImpl: Impl = impl) => {
	const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));
	const txQuery = jest.fn(async (sql: string, params: unknown[]) => txImpl(sql, params));
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: txQuery,
	};
	const service = new ClientImportService({ query, createQueryRunner: () => runner } as unknown as DataSource);

	return { service, query, txQuery, runner };
};

/** Base de prueba: Acme y Beta con N° cliente, listas del holding y países. */
const db: Impl = (sql, params) => {
	if (sql.includes('FROM clients c WHERE') && sql.includes('client_number')) {
		const keys = params[1] as string[];

		return [
			...(keys.includes('cl-1') ? [{ ...ACME, key: 'cl-1' }] : []),
			...(keys.includes('cl-2') ? [{ ...BETA, key: 'cl-2' }] : []),
			...(keys.includes('dup')
				? [
						{ ...ACME, key: 'dup' },
						{ ...BETA, key: 'dup' },
					]
				: []),
		];
	}
	if (sql.includes('FROM master_data'))
		return [
			{ category: 'industries', value: 'Transporte' },
			{ category: 'segments', value: 'Enterprise' },
			{ category: 'segments', value: 'SMB' },
		];
	if (sql.includes('FROM countries'))
		return [
			{ code: 'CL', name_es: 'Chile', name_en: 'Chile' },
			{ code: 'PE', name_es: 'Perú', name_en: 'Peru' },
		];

	return [];
};

const dto = (
	rows: ClientImportApplyDto['rows'],
	fields: ClientImportApplyDto['fields'] = ['industry', 'segment', 'country', 'client_since', 'notes']
): ClientImportApplyDto => ({
	key_field: 'client_number',
	fields,
	rows,
});

describe('ClientImportService · vista previa (plan fila a fila)', () => {
	it('encuentra por N° cliente sin distinguir mayúsculas, calcula los cambios y marca sin cambios, no encontrada y ambigua', async () => {
		const { service } = build(db);
		const result = await service.preview(
			HOLDING,
			dto([
				{ row: 2, key: ' CL-1 ', fields: { industry: 'Transporte', segment: 'Enterprise', notes: 'nuevo' } },
				{ row: 3, key: 'CL-2', fields: { notes: 'vip' } },
				{ row: 4, key: 'CL-9', fields: { notes: 'x' } },
				{ row: 5, key: 'dup', fields: { notes: 'x' } },
			])
		);

		expect(result.counts).toEqual({ total: 4, updated: 1, unchanged: 1, not_found: 1, ambiguous: 1, failed: 0 });
		expect(result.rows[0]).toMatchObject({
			status: 'updated',
			client: { id: 'c-acme', name: 'Acme' },
			changes: [
				{ field: 'industry', from: null, to: 'Transporte' },
				{ field: 'notes', from: null, to: 'nuevo' },
			],
		});
		expect(result.rows[1]).toMatchObject({ status: 'unchanged', client: { id: 'c-beta' }, changes: [] });
		expect(result.rows[2]).toMatchObject({ status: 'not_found', client: null });
		expect(result.rows[3]).toMatchObject({ status: 'ambiguous', client: null });
		expect(result.rows[3].errors[0]).toContain('2 clientes comparten la clave');
		// La vista previa solo lee.
		expect(result).not.toHaveProperty('batch_id');
	});

	it('valida contra los catálogos del holding y resuelve el país (nombre o código); ignora los campos no mapeados', async () => {
		const { service } = build(db);
		const result = await service.preview(
			HOLDING,
			dto(
				[
					{ row: 2, key: 'CL-1', fields: { segment: 'Startup', notes: 'x' } },
					{ row: 3, key: 'CL-2', fields: { country: 'pe', industry: 'Transporte', notes: 'ignorada' } },
					{ row: 4, key: 'CL-1', fields: { country: 'Narnia' } },
				],
				['segment', 'country', 'industry']
			)
		);

		expect(result.rows[0]).toMatchObject({
			status: 'failed',
			errors: ['El segmento "Startup" no está en la lista del holding (Administración › Catálogos)'],
		});
		expect(result.rows[1]).toMatchObject({
			status: 'updated',
			changes: [
				{ field: 'country', from: null, to: 'Perú' },
				{ field: 'industry', from: null, to: 'Transporte' },
			],
		});
		expect(result.rows[2]).toMatchObject({ status: 'failed', errors: ['País no reconocido: Narnia'] });
	});

	it('con clave RUT busca por la razón social vinculada (RUT normalizado) y llega al cliente comercial', async () => {
		const { service, query } = build((sql, params) =>
			sql.includes('FROM client_entities ce')
				? (params[1] as string[]).includes('765432109')
					? [{ ...ACME, key: '765432109' }]
					: []
				: db(sql, params)
		);
		const result = await service.preview(HOLDING, {
			key_field: 'tax_id',
			fields: ['notes'],
			rows: [{ row: 2, key: '76.543.210-9', fields: { notes: 'por rut' } }],
		});

		expect(result.rows[0]).toMatchObject({ status: 'updated', client: { id: 'c-acme' } });
		const sql = String(query.mock.calls.find((call) => String(call[0]).includes('client_entities'))?.[0]);

		expect(sql).toContain('client_entity_clients');
		expect(sql).toContain("regexp_replace(ce.tax_id, '[^0-9kK]', '', 'g')");
	});
});

describe('ClientImportService · aplicar y revertir', () => {
	it('aplica solo las filas con cambios dentro de la transacción y guarda el lote con el antes/después de cada fila', async () => {
		const { service, txQuery } = build(db, (sql, params) =>
			sql.includes('INSERT INTO import_batches') ? [{ id: 'b-1', created_at: 'now' }] : db(sql, params)
		);
		const result = await service.apply(
			HOLDING,
			{
				...dto([
					{ row: 2, key: 'CL-1', fields: { industry: 'Transporte', country: 'Perú' } },
					{ row: 3, key: 'CL-2', fields: { notes: 'vip' } },
					{ row: 4, key: 'CL-9', fields: { notes: 'x' } },
				]),
				label: 'clientes.xlsx',
			},
			{ userId: 'u-1' }
		);

		expect(result).toMatchObject({ batch_id: 'b-1', counts: { updated: 1, unchanged: 1, not_found: 1 } });
		const calls = txQuery.mock.calls.map(([sql, params]) => [String(sql), params] as [string, unknown[]]);
		const updates = calls.filter(([sql]) => sql.startsWith('UPDATE clients'));

		expect(updates).toHaveLength(1);
		expect(updates[0][0]).toBe('UPDATE clients SET "industry" = $3, "country" = $4, "country_code" = $5 WHERE id = $1 AND holding_id = $2');
		expect(updates[0][1]).toEqual(['c-acme', HOLDING, 'Transporte', 'Perú', 'PE']);
		const batch = calls.find(([sql]) => sql.includes('INSERT INTO import_batches'))!;

		expect(batch[1]).toEqual([
			HOLDING,
			'clientes.xlsx',
			'client_number',
			JSON.stringify(['industry', 'segment', 'country', 'client_since', 'notes']),
			3,
			1,
			2,
			0,
			'u-1',
		]);
		const rows = calls.filter(([sql]) => sql.includes('INSERT INTO import_batch_rows'));

		expect(rows).toHaveLength(3);
		expect(rows[0][1]).toEqual([
			'b-1',
			HOLDING,
			2,
			'CL-1',
			'c-acme',
			'updated',
			JSON.stringify({ industry: null, country: 'Chile', country_code: 'CL' }),
			JSON.stringify({ industry: 'Transporte', country: 'Perú', country_code: 'PE' }),
			null,
		]);
		expect(rows[2][1].slice(4, 6)).toEqual([null, 'not_found']);
		// La transacción: marca de escritor de la API, trabajo y commit.
		expect(calls[0][0]).toContain('sapira');
	});

	it('revertir restaura solo los campos cuyo valor actual sigue siendo el importado y deja constancia de los demás', async () => {
		const { service, txQuery } = build(db, (sql) => {
			if (sql.includes('FROM import_batches WHERE id')) return [{ id: 'b-1', reverted_at: null }];
			if (sql.includes('FROM import_batch_rows r'))
				return [
					// `row_id` aparte de `c.id`: la consulta trae las columnas del cliente y la fila del lote a la vez.
					{
						row_id: 'r-1',
						entity_id: 'c-acme',
						before: { industry: null, notes: null },
						after: { industry: 'Transporte', notes: 'nuevo' },
						...ACME,
						industry: 'Transporte',
						notes: 'editada después',
					},
					{ row_id: 'r-2', entity_id: 'c-beta', before: { segment: null }, after: { segment: 'SMB' }, ...BETA, segment: 'Otro' },
				];

			return [];
		});
		const result = await service.revert(HOLDING, 'b-1', { userId: 'u-2' });

		expect(result).toEqual({ batch_id: 'b-1', restored_rows: 1, kept_rows: 1, kept_fields: 2 });
		const calls = txQuery.mock.calls.map(([sql, params]) => [String(sql), params] as [string, unknown[]]);
		const updates = calls.filter(([sql]) => sql.startsWith('UPDATE clients'));

		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual(['UPDATE clients SET "industry" = $3 WHERE id = $1 AND holding_id = $2', ['c-acme', HOLDING, null]]);
		const rowUpdates = calls.filter(([sql]) => sql.startsWith('UPDATE import_batch_rows'));

		expect(rowUpdates[0][1]).toEqual(['r-1', JSON.stringify(['industry']), JSON.stringify(['notes'])]);
		expect(rowUpdates[1][1]).toEqual(['r-2', JSON.stringify([]), JSON.stringify(['segment'])]);
		const batch = calls.find(([sql]) => sql.startsWith('UPDATE import_batches'))!;

		expect(batch[1]).toEqual(['b-1', 'u-2', JSON.stringify({ restored_rows: 1, kept_rows: 1, kept_fields: 2 })]);
	});

	it('revertir: 404 si el lote no es del holding y 409 already_reverted si ya se revirtió', async () => {
		const missing = build(db, () => []);

		await expect(missing.service.revert(HOLDING, 'b-x', { userId: 'u' })).rejects.toBeInstanceOf(NotFoundException);
		const reverted = build(db, (sql) => (sql.includes('FROM import_batches WHERE id') ? [{ id: 'b-1', reverted_at: '2026-10-19' }] : []));

		await expect(reverted.service.revert(HOLDING, 'b-1', { userId: 'u' })).rejects.toBeInstanceOf(ConflictException);
		expect(reverted.runner.rollbackTransaction).toHaveBeenCalled();
	});
});

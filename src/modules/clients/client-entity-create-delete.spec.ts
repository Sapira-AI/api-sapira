import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientDirectoryService } from './client-directory.service';
import { insertClientEntity } from './client-entity-writer';

type Impl = (sql: string, params: unknown[]) => unknown;

/** `dataSource.query` (lecturas) y un runner de transacción (escrituras con la marca de la API). */
const build = (impl: Impl, txImpl: Impl = () => []) => {
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
	const service = new ClientDirectoryService({ query, createQueryRunner: () => runner } as unknown as DataSource);

	return { service, query, txQuery, runner };
};

const sqls = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => String(sql));

describe('insertClientEntity (camino único de alta)', () => {
	it('inserta la razón social y su vínculo no principal; los campos extra solo si traen valor', async () => {
		const query = jest.fn(
			async (...args: [string, unknown[]?]): Promise<any> =>
				args[0].includes('INSERT INTO client_entities')
					? [{ id: 'e-new' }]
					: args[0].includes('FROM countries')
						? [{ code: 'CL', name_es: 'Chile', name_en: 'Chile' }]
						: [{ id: 'link-1' }]
		);
		const call = (text: string) => query.mock.calls.find((entry) => String(entry[0]).includes(text)) as [string, unknown[]];

		await insertClientEntity({ query } as never, 'h-1', {
			client_id: 'c-1',
			legal_name: 'Norte SpA',
			tax_id: '76.543.210-K',
			country: 'Chile',
			address: null,
			email: null,
			payment_terms: null,
		});

		// Ronda 3 de Configuración: el país en texto se resuelve a su código ISO (`country_code`) y viaja en el INSERT.
		expect(call('INSERT INTO client_entities')[1]).toEqual(['h-1', 'c-1', 'Norte SpA', '76.543.210-K', 'Chile', 'CL', null, null, null]);
		expect(call('INSERT INTO client_entity_clients')[0]).toContain('is_primary) VALUES ($1, $2, $3, false)');
		expect(query).toHaveBeenCalledTimes(3);

		query.mockClear();
		await insertClientEntity(
			{ query } as never,
			'h-1',
			{
				client_id: 'c-1',
				legal_name: 'N',
				tax_id: '1-9',
				country: 'Chile',
				address: null,
				email: null,
				payment_terms: { kind: 'net', days: 30 },
				phone: '+56 2',
			},
			{ makePrimaryIfNone: true }
		);

		expect(call('INSERT INTO client_entities')[0]).toContain('payment_terms, phone)');
		expect(call('INSERT INTO client_entities')[1]).toEqual([
			'h-1',
			'c-1',
			'N',
			'1-9',
			'Chile',
			'CL',
			null,
			null,
			'{"kind":"net","days":30}',
			'+56 2',
		]);
		expect(call('SET is_primary = true')).toBeDefined();
	});
});

describe('ClientDirectoryService · crear razón social', () => {
	const input = { client_id: 'c-1', legal_name: ' Norte SpA ', tax_id: '76.543.210-K', country: 'Chile', legal_address: 'Av. 1' };

	it('404 si el cliente comercial no es del holding', async () => {
		const { service } = build(() => []);

		await expect(service.createEntity('h-1', input)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('409 duplicate_tax_id con la razón social que ya usa el RUT (misma regla que editar)', async () => {
		const { service, txQuery } = build((sql) =>
			sql.includes('FROM clients') ? [{ id: 'c-1' }] : sql.includes('regexp_replace') ? [{ id: 'e-9', legal_name: 'Norte Antigua' }] : []
		);
		const error = await service.createEntity('h-1', input).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as ConflictException).message).toContain('Norte Antigua');
		expect((error as { code?: string }).code).toBe('duplicate_tax_id');
		expect(txQuery).not.toHaveBeenCalled();
	});

	it('con allow_duplicate_tax_id crea igual: marca de la API primero, alta compartida y principal si el cliente no tenía', async () => {
		const { service, query, txQuery } = build(
			(sql) => (sql.includes('FROM clients') ? [{ id: 'c-1' }] : []),
			(sql) =>
				sql.includes('INSERT INTO client_entities')
					? [{ id: 'e-new' }]
					: sql.includes('INSERT INTO client_entity_clients')
						? [{ id: 'l-1' }]
						: [{ id: 'e-new', legal_name: 'Norte SpA' }]
		);

		const row = await service.createEntity('h-1', input, true);

		expect(row).toMatchObject({ id: 'e-new' });
		expect(sqls(query).some((sql) => sql.includes('regexp_replace'))).toBe(false);
		const tx = sqls(txQuery);
		const insert = txQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO client_entities')) as unknown[];

		expect(tx[0]).toContain("set_config('sapira.writer', 'api', true)");
		expect(tx.some((sql) => sql.includes('INSERT INTO client_entities'))).toBe(true);
		// Sin catálogo de países en el mock, el código queda null y el texto se respeta.
		expect(insert[1]).toEqual(['h-1', 'c-1', 'Norte SpA', '76.543.210-K', 'Chile', null, 'Av. 1', null, null]);
		expect(tx.some((sql) => sql.includes('SET is_primary = true'))).toBe(true);
	});

	it('Traer desde ERP: nace vinculada al partner en la misma transacción (odoo_partner_id en el INSERT)', async () => {
		const { service, txQuery } = build(
			(sql) => (sql.includes('FROM clients') ? [{ id: 'c-1' }] : []),
			(sql) =>
				sql.includes('INSERT INTO client_entities')
					? [{ id: 'e-new' }]
					: sql.includes('INSERT INTO client_entity_clients')
						? [{ id: 'l-1' }]
						: sql.includes('odoo_partner_id = ANY')
							? []
							: [{ id: 'e-new', odoo_partner_id: 200 }]
		);

		await service.createEntity('h-1', input, false, { odooPartnerId: 200 });
		const tx = sqls(txQuery);

		expect(tx[0]).toContain("set_config('sapira.writer', 'api', true)");
		expect(tx[1]).toContain('odoo_partner_id = ANY');
		const insert = txQuery.mock.calls.find((entry) => String(entry[0]).includes('INSERT INTO client_entities')) as unknown[];

		expect(String(insert[0])).toContain('payment_terms, odoo_partner_id)');
		expect(insert[1]).toEqual(['h-1', 'c-1', 'Norte SpA', '76.543.210-K', 'Chile', null, 'Av. 1', null, null, 200]);
	});

	it('Traer desde ERP: si el partner se vinculó a otra razón social mientras tanto, 409 dentro de la transacción y no inserta', async () => {
		const { service, txQuery, runner } = build(
			(sql) => (sql.includes('FROM clients') ? [{ id: 'c-1' }] : []),
			(sql) =>
				sql.includes('odoo_partner_id = ANY') ? [{ id: 'e-9', legal_name: 'Otra SpA', odoo_partner_id: 200, client_name: 'Grupo Otro' }] : []
		);
		const error = await service.createEntity('h-1', input, false, { odooPartnerId: 200 }).catch((caught: unknown) => caught);

		expect((error as { code?: string }).code).toBe('partner_already_linked');
		expect((error as ConflictException).message).toContain('Otra SpA');
		expect((error as ConflictException).message).toContain('Grupo Otro');
		expect(sqls(txQuery).some((sql) => sql.includes('INSERT INTO client_entities'))).toBe(false);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	it('Traer desde ERP con RUT ya registrado: el mismo 409 duplicate_tax_id (se confirma con "Crear igual")', async () => {
		const { service, txQuery } = build((sql) =>
			sql.includes('FROM clients') ? [{ id: 'c-1' }] : sql.includes('regexp_replace') ? [{ id: 'e-9', legal_name: 'Norte Antigua' }] : []
		);
		const error = await service.createEntity('h-1', input, false, { odooPartnerId: 200 }).catch((caught: unknown) => caught);

		expect((error as { code?: string }).code).toBe('duplicate_tax_id');
		expect(txQuery).not.toHaveBeenCalled();
	});
});

describe('ClientDirectoryService · eliminar razón social', () => {
	const usage = (counts: Partial<Record<'contracts' | 'invoices' | 'legacy_invoices' | 'subscriptions' | 'documents', number>>) => () => [
		{ contracts: 0, invoices: 0, legacy_invoices: 0, subscriptions: 0, documents: 0, ...counts },
	];

	it('revisión: bloqueo entity_in_use con los conteos y el siguiente paso', async () => {
		const { service } = build(usage({ contracts: 2, invoices: 1 }));
		const check = await service.deletionCheck('h-1', 'e-1');

		expect(check.can_delete).toBe(false);
		expect(check.blockers).toEqual([
			expect.objectContaining({
				code: 'entity_in_use',
				message: expect.stringContaining('2 contratos, 1 factura'),
				next_step: expect.any(String),
			}),
		]);
	});

	it('eliminar con uso: 409 entity_in_use y no escribe', async () => {
		const { service, txQuery } = build(usage({ subscriptions: 1 }));
		const error = await service.deleteEntity('h-1', 'e-1').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as { code?: string }).code).toBe('entity_in_use');
		expect(txQuery).not.toHaveBeenCalled();
	});

	it('404 si la razón social no es del holding', async () => {
		const { service } = build(() => []);

		await expect(service.deletionCheck('h-1', 'e-x')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('sin uso: borra vínculos y razón social, y promueve otra principal del cliente si era la suya', async () => {
		const { service, txQuery } = build(usage({ documents: 3 }), (sql) =>
			sql.startsWith('DELETE FROM client_entity_clients')
				? [
						[
							{ client_id: 'c-1', is_primary: true },
							{ client_id: 'c-2', is_primary: false },
						],
						2,
					]
				: []
		);

		const result = await service.deleteEntity('h-1', 'e-1');

		expect(result).toEqual({ deleted: true, id: 'e-1', unlinked_clients: 2, documents_unlinked: 3 });
		const tx = sqls(txQuery);

		expect(tx[0]).toContain("set_config('sapira.writer', 'api', true)");
		expect(tx[1]).toContain('DELETE FROM client_entity_clients');
		expect(tx[2]).toContain('DELETE FROM client_entities');
		expect(tx[3]).toContain('SET is_primary = true');
		expect(txQuery.mock.calls[3][1]).toEqual([['c-1'], 'h-1']);
	});

	it('una FK desconocida (23503) se explica como entity_in_use en vez de un 500', async () => {
		const { service } = build(usage({}), (sql) => {
			if (sql.startsWith('DELETE FROM client_entities')) throw Object.assign(new Error('fk'), { code: '23503' });

			return [];
		});

		await expect(service.deleteEntity('h-1', 'e-1')).rejects.toBeInstanceOf(ConflictException);
	});
});

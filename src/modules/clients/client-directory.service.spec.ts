import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientDirectoryService } from './client-directory.service';

describe('ClientDirectoryService', () => {
	const build = (impl: (sql: string, params: unknown[]) => unknown[], txImpl?: (sql: string, params: unknown[]) => unknown[]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));
		const txQuery = jest.fn(async (sql: string, params: unknown[]) => (txImpl ?? impl)(sql, params));
		const transaction = jest.fn(async (work: (manager: { query: typeof txQuery }) => unknown) => work({ query: txQuery }));

		return { service: new ClientDirectoryService({ query, transaction } as unknown as DataSource), query, txQuery };
	};

	it('lista razones sociales sin cliente, con búsqueda y orden de lista blanca', async () => {
		const { service, query } = build((sql) =>
			sql.includes('COUNT(*) AS total')
				? [{ total: '21' }]
				: [{ id: 'e-1', legal_name: 'COPEC', clients: [], clients_count: '0', receivable: '10' }]
		);

		const page = await service.listEntities('h-1', {
			page: 2,
			limit: 10,
			search: 'cop',
			unassigned: true,
			sortBy: 'receivable',
			sortOrder: 'desc',
		});

		expect(page).toMatchObject({ items: 21, pages: 3, currentPage: 2 });
		expect(page.data[0]).toMatchObject({ legal_name: 'COPEC', clients_count: 0, receivable: 10 });
		const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('LIMIT'))!;

		expect(sql).toContain('NOT EXISTS (SELECT 1 FROM client_entity_clients');
		expect(sql).toContain('ORDER BY receivable DESC NULLS LAST');
		expect(sql).toContain('OFFSET 10');
		expect(params).toContain('%cop%');
	});

	it('asignar: 404 si el cliente no es del holding', async () => {
		const { service } = build(() => []);

		await expect(service.assignEntities('h-1', 'c-1', ['e-1'])).rejects.toBeInstanceOf(NotFoundException);
	});

	it('asignar: rechaza razones sociales de otro holding', async () => {
		const { service } = build((sql) => (sql.includes('FROM clients') ? [{ id: 'c-1' }] : [{ id: 'e-1' }]));

		await expect(service.assignEntities('h-1', 'c-1', ['e-1', 'e-2'])).rejects.toBeInstanceOf(BadRequestException);
	});

	it('asignar: inserta las nuevas y marca principal si el cliente no tenía', async () => {
		const { service, txQuery } = build(
			(sql) => (sql.includes('FROM clients') ? [{ id: 'c-1' }] : [{ id: 'e-1' }, { id: 'e-2' }]),
			(sql) => {
				if (sql.includes('has_primary')) return [{ has_primary: false }];
				if (sql.includes('INSERT')) return [{ id: 'r-1', client_entity_id: 'e-1' }];

				return [];
			}
		);

		const result = await service.assignEntities('h-1', 'c-1', ['e-1', 'e-2']);

		expect(result).toEqual({ assigned: 1, skipped: 1 });
		expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('SET is_primary = true'), ['r-1']);
	});

	it('lista contactos filtrando por cliente y tipo', async () => {
		const { service, query } = build((sql) =>
			sql.includes('COUNT(*) AS total') ? [{ total: '3' }] : [{ id: 'k-1', name: null, email: 'a@b.cl', client_name: 'Andes' }]
		);

		const page = await service.listContacts('h-1', { clientId: 'c-1', contactType: 'Cobranza' });

		expect(page.items).toBe(3);
		expect(page.data[0]).toMatchObject({ name: null, email: 'a@b.cl', client_name: 'Andes' });
		expect(query.mock.calls[0][1]).toEqual(['h-1', 'c-1', 'Cobranza']);
	});
});

describe('ClientDirectoryService · edición', () => {
	const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

		return { service: new ClientDirectoryService({ query } as unknown as DataSource), query };
	};

	it('razón social: 409 si el nuevo RUT ya existe en el holding (ignora puntos y guion)', async () => {
		const { service } = build((sql) => {
			if (sql.startsWith('SELECT id, tax_id')) return [{ id: 'e-1', tax_id: '76.111.111-1' }];
			if (sql.includes('regexp_replace')) return [{ legal_name: 'Otra SpA' }];

			return [];
		});

		await expect(service.updateEntity('h-1', 'e-1', { tax_id: '76222222-2' })).rejects.toThrow('Otra SpA');
	});

	it('razón social: con allowDuplicateTaxId guarda aunque el RUT exista (duplicados legítimos)', async () => {
		const { service, query } = build((sql) => {
			if (sql.startsWith('SELECT id, tax_id')) return [{ id: 'e-1', tax_id: '1-9' }];
			if (sql.startsWith('UPDATE')) return [[{ id: 'e-1', tax_id: '76222222-2' }], 1];

			return [];
		});

		await expect(service.updateEntity('h-1', 'e-1', { tax_id: '76222222-2' }, true)).resolves.toMatchObject({ tax_id: '76222222-2' });
		expect(query.mock.calls.some(([sql]) => (sql as string).includes('regexp_replace'))).toBe(false);
	});

	it('razón social: actualiza solo campos de la lista blanca, acotado al holding', async () => {
		const { service, query } = build((sql) => {
			if (sql.startsWith('SELECT id, tax_id')) return [{ id: 'e-1', tax_id: '1-9' }];
			if (sql.startsWith('UPDATE')) return [[{ id: 'e-1', legal_name: 'Nueva' }], 1];

			return [];
		});

		const row = await service.updateEntity('h-1', 'e-1', { legal_name: 'Nueva', holding_id: 'otro' } as never);

		expect(row).toEqual({ id: 'e-1', legal_name: 'Nueva' });
		const [sql, params] = query.mock.calls.find(([text]) => (text as string).startsWith('UPDATE'))!;

		expect(sql).toContain('SET legal_name = $3 WHERE id = $1 AND holding_id = $2');
		expect(params).toEqual(['e-1', 'h-1', 'Nueva']);
	});

	it('contactos en lote: exige cliente o rol, y valida el cliente del holding', async () => {
		const { service } = build(() => []);

		await expect(service.bulkUpdateContacts('h-1', ['k-1'], {})).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.bulkUpdateContacts('h-1', ['k-1'], { client_id: 'c-x' })).rejects.toBeInstanceOf(NotFoundException);
	});

	it('contactos en lote: reasigna y cambia rol en una sola sentencia', async () => {
		const { service, query } = build((sql) => {
			if (sql.includes('FROM clients')) return [{ id: 'c-1' }];

			return [[{ id: 'k-1' }, { id: 'k-2' }], 2];
		});

		expect(await service.bulkUpdateContacts('h-1', ['k-1', 'k-2'], { client_id: 'c-1', contact_type: 'Cobranza' })).toEqual({ updated: 2 });
		expect(query.mock.calls.at(-1)).toEqual([
			expect.stringContaining('SET client_id = $3, contact_type = $4'),
			[['k-1', 'k-2'], 'h-1', 'c-1', 'Cobranza'],
		]);
	});
});

import { ConflictException, NotFoundException } from '@nestjs/common';

import { ClientsService } from './clients.service';

type Row = Record<string, unknown>;

const CLIENT = { id: 'c-1', holding_id: 'h-1', name_commercial: 'Nautica' };

/** `ClientsService` con repositorios falsos: lecturas por `clientRepository.query`, escrituras por un runner (`withApiWriter`). */
const build = ({
	usage = {},
	relation = { id: 'link-1', is_primary: false },
	client = CLIENT as Row | null,
	txImpl = ((): unknown => []) as (sql: string) => unknown,
} = {}) => {
	const txQuery = jest.fn(async (sql: string) => txImpl(sql));
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: txQuery,
	};
	const query = jest.fn(async () => [usage]);
	const clientRepository = {
		findOne: jest.fn(async () => client),
		query,
		manager: { connection: { createQueryRunner: () => runner } },
	};
	const linkRepository = { findOne: jest.fn(async () => relation) };
	const service = new ClientsService(clientRepository as never, {} as never, linkRepository as never, {} as never);
	const writes = () => txQuery.mock.calls.map(([sql]) => String(sql)).filter((sql) => !sql.includes('set_config'));

	return { service, query, runner, writes };
};

const conflictOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ConflictException);

		return { code: (error as { code?: string }).code, message: ((error as ConflictException).getResponse() as { message: string }).message };
	}
	throw new Error('Se esperaba un 409');
};

describe('ClientsService · desasignar razón social (DELETE /clients/:id/entities/:entityId)', () => {
	it('sin uso entre ambos: borra solo el vínculo con la marca de la API', async () => {
		const { service, writes, runner } = build({ usage: { contracts: 0, invoices: 0, legacy_invoices: 0, subscriptions: 0 } });

		await expect(service.unassignEntity('c-1', 'e-1', 'h-1')).resolves.toMatchObject({ success: true, new_primary_entity_id: null });
		expect(writes()).toEqual([expect.stringContaining('DELETE FROM client_entity_clients WHERE id = $1')]);
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('con contratos del cliente con esa razón social: 409 entity_client_in_use con los conteos, y no escribe', async () => {
		const { service, writes } = build({ usage: { contracts: 2, invoices: 5, legacy_invoices: 0, subscriptions: 0 } });

		expect(await conflictOf(service.unassignEntity('c-1', 'e-1', 'h-1'))).toEqual({
			code: 'entity_client_in_use',
			message: 'No se puede desasignar: tiene 2 contratos y 5 facturas con este cliente.',
		});
		expect(writes()).toEqual([]);
	});

	it('solo con facturas (también históricas): bloquea igual', async () => {
		const { service } = build({ usage: { contracts: 0, invoices: 1, legacy_invoices: 3, subscriptions: 0 } });

		expect((await conflictOf(service.unassignEntity('c-1', 'e-1', 'h-1'))).message).toBe(
			'No se puede desasignar: tiene 1 factura y 3 facturas históricas con este cliente.'
		);
	});

	it('vínculo inexistente: 404', async () => {
		const { service } = build({ relation: null as never });

		await expect(service.unassignEntity('c-1', 'e-1', 'h-1')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('cliente de otro holding: 404 sin revisar el vínculo', async () => {
		const { service, query } = build({ client: { ...CLIENT, holding_id: 'h-otro' } });

		await expect(service.unassignEntity('c-1', 'e-1', 'h-1')).rejects.toBeInstanceOf(NotFoundException);
		expect(query).not.toHaveBeenCalled();
	});

	it('si era la principal, la siguiente más antigua del cliente pasa a serlo', async () => {
		const { service, writes } = build({
			usage: {},
			relation: { id: 'link-1', is_primary: true },
			txImpl: (sql) => (sql.includes('UPDATE client_entity_clients') ? [{ client_entity_id: 'e-2' }] : []),
		});

		await expect(service.unassignEntity('c-1', 'e-1', 'h-1')).resolves.toMatchObject({ new_primary_entity_id: 'e-2' });
		expect(writes()[1]).toContain('ORDER BY created_at, id LIMIT 1');
	});
});

describe('ClientsService · eliminar cliente (DELETE /clients/:id)', () => {
	const none = { contracts: 0, invoices: 0, legacy_invoices: 0, legacy_mrr: 0, subscriptions: 0, quotes: 0, owned_entities: 0 };

	it('sin uso: borra el cliente del holding con la marca de la API', async () => {
		const { service, writes } = build({ usage: none });

		await expect(service.remove('c-1', 'h-1')).resolves.toMatchObject({ success: true });
		expect(writes()).toEqual([expect.stringContaining('DELETE FROM clients WHERE id = $1 AND holding_id = $2')]);
	});

	it('con contratos o facturas: 409 client_in_use con los conteos y no escribe', async () => {
		const { service, writes } = build({ usage: { ...none, contracts: 2, invoices: 5 } });

		expect(await conflictOf(service.remove('c-1', 'h-1'))).toEqual({
			code: 'client_in_use',
			message: 'No se puede eliminar: tiene 2 contratos y 5 facturas.',
		});
		expect(writes()).toEqual([]);
	});

	it('con cotizaciones: bloquea (la cascada las borraría)', async () => {
		const { service } = build({ usage: { ...none, quotes: 1 } });

		expect((await conflictOf(service.remove('c-1', 'h-1'))).message).toBe('No se puede eliminar: tiene 1 cotización.');
	});

	it('con razones sociales creadas con él (client_entities.client_id, cascada): 409 client_owns_entities', async () => {
		const { service, writes } = build({ usage: { ...none, owned_entities: 2 } });

		expect(await conflictOf(service.remove('c-1', 'h-1'))).toEqual({
			code: 'client_owns_entities',
			message: 'No se puede eliminar: 2 razones sociales se crearon con este cliente y se borrarían con él.',
		});
		expect(writes()).toEqual([]);
	});

	it('de otro holding (no aparece): 404', async () => {
		const { service, query } = build();

		query.mockResolvedValueOnce([]);
		await expect(service.remove('c-1', 'h-1')).rejects.toBeInstanceOf(NotFoundException);
	});
});

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientActivityService } from './client-activity.service';

const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
	const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

	return { service: new ClientActivityService({ query } as unknown as DataSource), query };
};

const base = (sql: string) => {
	if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];
	if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'u-1' }];
	if (sql.includes('COUNT(*) AS total')) return [{ total: '2' }];

	return [
		{
			type: 'note',
			id: 'n-1',
			occurred_at: '2026-09-24T12:00:00Z',
			title: 'Nota',
			detail: 'Pagan el viernes',
			actor: 'Domi',
			actor_id: 'u-1',
			ref_kind: null,
			ref_id: null,
			amount: null,
			currency: null,
		},
		{
			type: 'invoice',
			id: 'i-1',
			occurred_at: '2026-09-01T00:00:00Z',
			title: 'Factura emitida FE-1',
			detail: 'Vencida',
			actor: null,
			actor_id: null,
			ref_kind: 'invoice',
			ref_id: 'i-1',
			amount: '150',
			currency: 'USD',
		},
	];
};

describe('ClientActivityService', () => {
	it('une solo las fuentes pedidas y marca como borrables solo las notas propias', async () => {
		const { service, query } = build(base);
		const page = await service.list('c-1', 'h-1', 'auth-1', { types: ['note', 'invoice'], limit: 30 });
		const listSql = query.mock.calls.find(([sql]) => (sql as string).includes('ORDER BY occurred_at DESC'))![0] as string;

		expect(listSql).toContain('FROM client_activity_notes');
		expect(listSql).toContain('FROM invoices i');
		expect(listSql).not.toContain('FROM quotes');
		expect(page.items).toBe(2);
		expect(page.data[0]).toMatchObject({ type: 'note', can_delete: true, actor: 'Domi' });
		expect(page.data[1]).toMatchObject({ type: 'invoice', can_delete: false, amount: 150, ref: { kind: 'invoice', id: 'i-1' } });
	});

	it('solo el autor borra su nota', async () => {
		const { service } = build((sql) => (sql.includes('FROM client_activity_notes WHERE id') ? [{ created_by: 'u-9' }] : base(sql)));

		await expect(service.deleteNote('c-1', 'n-1', 'h-1', 'auth-1')).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('404 si el cliente no es del holding', async () => {
		const { service } = build(() => []);

		await expect(service.list('c-1', 'h-9', 'auth-1', {})).rejects.toBeInstanceOf(NotFoundException);
	});

	it('filtrar sin notas mantiene nombres y tipos de columna (la primera rama es la cabecera tipada)', async () => {
		const { service, query } = build(base);

		await service.list('c-1', 'h-1', 'auth-1', { types: ['document'] });
		const listSql = query.mock.calls.find(([sql]) => (sql as string).includes('ORDER BY occurred_at DESC'))![0] as string;

		expect(listSql.indexOf('NULL::text AS type')).toBeLessThan(listSql.indexOf('FROM client_documents'));
		expect(listSql).not.toContain('FROM client_activity_notes');
	});
});

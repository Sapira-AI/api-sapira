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
			occurred_on: '2026-09-24',
			all_day: false,
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
			occurred_on: new Date(2026, 8, 1),
			all_day: true,
			ref_parent_id: 'k-1',
		},
	];
};

describe('ClientActivityService', () => {
	it('une solo las fuentes pedidas y marca como borrables solo las notas propias', async () => {
		const { service, query } = build(base);
		const page = await service.list('c-1', 'h-1', 'auth-1', { types: ['note', 'invoice'], limit: 30 });
		const listSql = query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT'))![0] as string;

		expect(listSql).toContain('FROM client_activity_notes');
		expect(listSql).toContain('FROM invoices i');
		expect(listSql).not.toContain('FROM quotes');
		expect(page.items).toBe(2);
		expect(page.data[0]).toMatchObject({ type: 'note', can_delete: true, actor: 'Domi' });
		expect(page.data[1]).toMatchObject({
			type: 'invoice',
			can_delete: false,
			amount: 150,
			ref: { kind: 'invoice', id: 'i-1', contract_id: 'k-1' },
		});
	});

	it('orden cronológico estricto por día del negocio: las fuentes con solo fecha no se corren al día anterior', async () => {
		const { service, query } = build(base);
		const page = await service.list('c-1', 'h-1', 'auth-1', {});
		const listSql = query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT'))![0] as string;

		// Día (fecha propia o el de la hora en America/Santiago) → con hora antes que solo fecha → hora → tipo → id (desempate estable).
		expect(listSql).toContain(
			"ORDER BY COALESCE(feed.occurred_day, (feed.occurred_at AT TIME ZONE 'America/Santiago')::date) DESC, (feed.occurred_day IS NOT NULL), occurred_at DESC, type, id"
		);
		// La emisión de la factura y la fecha de pago viajan como fecha, no como medianoche UTC.
		expect(listSql).toContain('i.issue_date, i.contract_id::text');
		expect(listSql).toContain('p.payment_date::date');
		expect(page.data[0]).toMatchObject({ occurred_on: '2026-09-24', all_day: false });
		expect(page.data[1]).toMatchObject({ occurred_on: '2026-09-01', all_day: true });
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
		const listSql = query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT'))![0] as string;

		expect(listSql.indexOf('NULL::text AS type')).toBeLessThan(listSql.indexOf('FROM client_documents'));
		expect(listSql).not.toContain('FROM client_activity_notes');
	});
});

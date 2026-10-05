import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientActivityService } from './client-activity.service';

const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
	const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

	const notifications = { createOrUpdate: jest.fn(async () => ({ notification: { id: 'a-1' }, recipient_count: 1 })) };

	return { service: new ClientActivityService({ query } as unknown as DataSource, notifications as never), query, notifications };
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
		expect(page.data[0]).toMatchObject({ type: 'note', can_delete: true, actor: 'Domi', author_avatar: { kind: 'initials' } });
		// El avatar del autor viaja en `meta` de la misma consulta del feed (sin consulta extra por nota).
		expect(listSql).toContain("'author_avatar_path', u.avatar_path");
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
		const [listSql, listParams] = query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT'))! as [string, unknown[]];

		// Día (fecha propia o el de la hora en la zona del holding, $3) → con hora antes que solo fecha → hora → tipo → id (desempate estable).
		expect(listSql).toContain(
			'ORDER BY COALESCE(feed.occurred_day, (feed.occurred_at AT TIME ZONE $3::text)::date) DESC, (feed.occurred_day IS NOT NULL), occurred_at DESC, type, id'
		);
		// Sin zona guardada: America/Santiago (ronda 4 de Configuración).
		expect(listParams).toEqual(['c-1', 'h-1', 'America/Santiago']);
		// La emisión de la factura y la fecha de pago viajan como fecha, no como medianoche UTC.
		expect(listSql).toContain('i.issue_date, i.contract_id::text');
		expect(listSql).toContain('p.payment_date::date');
		expect(page.data[0]).toMatchObject({ occurred_on: '2026-09-24', all_day: false });
		expect(page.data[1]).toMatchObject({ occurred_on: '2026-09-01', all_day: true });
	});

	it('ronda 4: el día de cada evento usa la zona horaria del holding', async () => {
		const { service, query } = build((sql) => (sql.includes('to_jsonb(hs)') ? [{ settings: { timezone: 'America/Lima' } }] : base(sql)));

		await service.list('c-1', 'h-1', 'auth-1', {});
		const [, params] = query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT'))! as [string, unknown[]];

		expect(params).toEqual(['c-1', 'h-1', 'America/Lima']);
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

	describe('menciones y referencias (contrato §8.7)', () => {
		const USER = '11111111-1111-4111-8111-111111111111';
		const OTHER = '33333333-3333-4333-8333-333333333333';
		const INVOICE = '22222222-2222-4222-8222-222222222222';
		const route =
			(extra: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined) =>
			(sql: string, params: unknown[]) => {
				const routed = extra(sql, params);

				if (routed) return routed;
				if (sql.includes('FROM clients WHERE id')) return [{ id: 'c-1', name_commercial: 'Acme' }];
				if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'u-1' }];
				if (sql.includes('JOIN user_holdings uh'))
					return (params[1] as string[]).filter((id) => id === USER).map((id) => ({ id, name: 'Leon' }));
				if (sql.includes('FROM users WHERE id = $1')) return [{ name: 'Domi' }];
				if (sql.includes('FROM invoices i LEFT JOIN contracts c'))
					return (params[2] as string[] | null)?.includes(INVOICE) || params[2] === null
						? [{ id: INVOICE, label: 'Factura F-12', amount: '1200', currency: 'USD', status: 'Pagada' }]
						: [];
				if (sql.includes('INSERT INTO client_activity_notes')) return [{ id: 'note-1', created_at: '2026-10-03T12:00:00Z' }];
				return [];
			};

		it('guarda menciones y referencias derivadas del texto y avisa al mencionado con el fragmento legible', async () => {
			const { service, query, notifications } = build(route());
			const body = `@[user:${USER}] revisa #[invoice:${INVOICE}] por favor`;
			const result = await service.addNote('c-1', 'h-1', 'auth-1', body);

			expect(result).toMatchObject({ id: 'note-1', mentioned_user_ids: [USER], references: [{ type: 'invoice', id: INVOICE }] });
			const insert = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO client_activity_notes'))!;

			expect(insert[1]).toEqual(['h-1', 'c-1', body, 'u-1', [USER], JSON.stringify([{ type: 'invoice', id: INVOICE }])]);
			expect(notifications.createOrUpdate).toHaveBeenCalledWith(
				'h-1',
				expect.objectContaining({
					type: 'user_mention',
					title: 'Domi te mencionó en Acme',
					message: '@Leon revisa #Factura F-12 por favor',
					action_type: 'open_client_activity',
					action_payload: { client_id: 'c-1', note_id: 'note-1' },
					recipients: { user_ids: [USER] },
					deduplication_key: 'client-note-mention:note-1',
					metadata: expect.objectContaining({ actor_user_id: 'u-1', author_id: 'u-1' }),
				})
			);
		});

		it('400 si la mención no es miembro activo o la referencia no es del cliente; sin menciones no avisa', async () => {
			const { service, notifications } = build(route());

			await expect(service.addNote('c-1', 'h-1', 'auth-1', `hola @[user:${OTHER}]`)).rejects.toThrow(
				'La persona mencionada no es parte de este holding'
			);
			await expect(service.addNote('c-1', 'h-1', 'auth-1', `ver #[contract:${OTHER}]`)).rejects.toMatchObject({
				response: { errors: [{ field: 'body', message: 'La referencia no pertenece a este cliente: contrato' }] },
			});
			await service.addNote('c-1', 'h-1', 'auth-1', 'Pagan el viernes');
			expect(notifications.createOrUpdate).not.toHaveBeenCalled();
		});

		it('referencias del cliente con etiqueta legible y enlace al front nuevo', async () => {
			const { service, query } = build(route());
			const result = await service.references('c-1', 'h-1', { type: 'invoice', search: 'F-1', limit: 5 });

			expect(result.data).toEqual([
				{ type: 'invoice', id: INVOICE, label: 'Factura F-12', sublabel: 'USD 1.200 · Pagada', href: `/facturacion?invoice=${INVOICE}` },
			]);
			const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('ORDER BY r.sort'))! as [string, unknown[]];

			expect(sql).toContain('LIMIT 5');
			expect(params).toEqual(['c-1', 'h-1', null, '%F-1%']);
		});

		it('la actividad devuelve la nota legible con menciones y referencias resueltas (y las eliminadas marcadas)', async () => {
			const { service } = build(
				route((sql) => {
					if (sql.includes('COUNT(*) AS total')) return [{ total: '1' }];
					if (sql.includes('FROM users WHERE id = ANY')) return [{ id: USER, name: 'Leon', avatar_path: null, avatar_preset: 'preset-07' }];
					if (sql.includes('LIMIT 30'))
						return [
							{
								type: 'note',
								id: 'note-1',
								occurred_at: '2026-10-03T12:00:00Z',
								title: 'Nota',
								detail: `@[user:${USER}] ver #[invoice:${INVOICE}] y #[quote:${OTHER}]`,
								actor: 'Domi',
								actor_id: 'u-1',
								occurred_on: '2026-10-03',
								all_day: false,
								meta: {
									mentions: [USER],
									author_avatar_path: 'users/u-1/foto.png',
									author_avatar_preset: null,
									references: [
										{ type: 'invoice', id: INVOICE },
										{ type: 'quote', id: OTHER },
									],
								},
							},
							{
								type: 'contract',
								id: 'log-1',
								occurred_at: '2026-10-02T12:00:00Z',
								title: null,
								detail: null,
								occurred_on: '2026-10-02',
								all_day: false,
								meta: {
									kind: 'change',
									change_type: 'UPDATE',
									fields: ['status'],
									number: 'CTR-2026-226',
									before: { status: 'Borrador' },
									after: { status: 'Activo' },
								},
							},
						];
					return undefined;
				})
			);
			const page = await service.list('c-1', 'h-1', 'auth-1', {});

			expect(page.data[0]).toMatchObject({
				detail: '@Leon ver #Factura F-12 y #elemento ya no disponible',
				author_avatar: { kind: 'upload', url: expect.stringMatching(/\/storage\/v1\/object\/public\/user-avatars\/users\/u-1\/foto\.png$/) },
				mentions: [{ id: USER, name: 'Leon', avatar: { kind: 'preset', preset_id: 'preset-07' }, exists: true }],
				references: [
					{ type: 'invoice', id: INVOICE, label: 'Factura F-12', exists: true },
					{ type: 'quote', id: OTHER, label: 'Cotización ya no disponible', exists: false },
				],
			});
			expect(page.data[0].body).toContain('@[user:');
			expect(page.data[1]).not.toHaveProperty('author_avatar');
			expect(page.data[1]).toMatchObject({ title: 'Contrato modificado · CTR-2026-226', detail: 'Estado: Borrador → Activo' });
		});
	});
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { QuoteStagesService } from './quote-stages.service';

type Row = Record<string, unknown>;
const S_DRAFT = '11111111-1111-4111-8111-111111111111';
const S_SENT = '22222222-2222-4222-8222-222222222222';
const S_SIGNED = '33333333-3333-4333-8333-333333333333';
const S_LOST = '44444444-4444-4444-8444-444444444444';

const existing: Row[] = [
	{ id: S_DRAFT, name: 'Recepcionado', kind: 'draft', is_deletable: true, quotes_count: '6' },
	{ id: S_SENT, name: 'Enviada', kind: 'sent', is_deletable: false, quotes_count: '61' },
	{ id: S_SIGNED, name: 'Firmada', kind: 'signed', is_deletable: false, quotes_count: '18' },
	{ id: S_LOST, name: 'Perdido', kind: 'lost', is_deletable: true, quotes_count: '0' },
];

const build = (handler: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FOR UPDATE')) return existing;
		if (sql.includes('INSERT INTO quote_stages')) return [{ id: 'stage-new' }];
		if (sql.includes('FROM quote_stages qs WHERE qs.holding_id'))
			return existing.map((row) => ({ ...row, color: '#000000', position: 0, is_system_stage: false }));

		return [];
	};
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: jest.fn(route),
	};
	const dataSource = { query: jest.fn(route), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;

	return { service: new QuoteStagesService(dataSource), runner };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const stage = (id: string | undefined, name: string, kind: string) => ({ id, name, kind }) as never;

describe('QuoteStagesService.validate', () => {
	it('un solo signed y un solo lost (varios contract_created valen), nombres únicos y al menos un draft', () => {
		expect(
			QuoteStagesService.validate([
				stage(S_DRAFT, 'Borrador', 'draft'),
				stage(S_SIGNED, 'Firmada', 'signed'),
				stage(undefined, 'Cerrada ganada', 'signed'),
				stage(undefined, 'borrador', 'draft'),
			]).map((error) => error.field)
		).toEqual(['stages.2.kind', 'stages.3.name']);
		expect(QuoteStagesService.validate([stage(S_SENT, 'Enviada', 'sent')])).toEqual([
			{ field: 'stages', message: 'Tiene que haber al menos una etapa de tipo borrador (draft)' },
		]);
		expect(
			QuoteStagesService.validate([
				stage(S_DRAFT, 'Recepcionado', 'draft'),
				stage(undefined, 'Negociando', 'draft'),
				stage(S_SENT, 'Enviada', 'sent'),
			])
		).toEqual([]);
		// SimpliRoute: "Contrato creado" y "Procesada previamente" conviven con el mismo kind; dos lost no.
		expect(
			QuoteStagesService.validate([
				stage(S_DRAFT, 'Recepcionado', 'draft'),
				stage(undefined, 'Contrato creado', 'contract_created'),
				stage(undefined, 'Procesada previamente', 'contract_created'),
				stage(S_LOST, 'Perdido', 'lost'),
				stage(undefined, 'Rechazada', 'lost'),
			]).map((error) => error.field)
		).toEqual(['stages.4.kind']);
	});
});

describe('QuoteStagesService.replace', () => {
	it('reordena por posiciones negativas, actualiza con id, crea sin id y elimina las ausentes sin cotizaciones, en una transacción', async () => {
		const { service, runner } = build();

		await service.replace(
			{
				stages: [
					stage(S_DRAFT, 'Recibido', 'draft'),
					stage(undefined, 'Negociando', 'draft'),
					stage(S_SENT, 'Enviada', 'sent'),
					stage(S_SIGNED, 'Firmada', 'signed'),
					stage(undefined, 'Contrato creado', 'contract_created'),
				],
			},
			'h-1',
			'auth-1'
		);
		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		// Perdido (0 cotizaciones, eliminable) se borra; Recepcionado se renombra; dos nuevas.
		expect(calls(runner.query, 'DELETE FROM quote_stages')[0][1]).toEqual([[S_LOST], 'h-1']);
		expect(calls(runner.query, 'SET position = -1 - position')).toHaveLength(1);
		const updates = calls(runner.query, 'UPDATE quote_stages SET name');
		const inserts = calls(runner.query, 'INSERT INTO quote_stages');

		expect(
			updates.map(([, params]) => [(params as unknown[])[0], (params as unknown[])[2], (params as unknown[])[4], (params as unknown[])[5]])
		).toEqual([
			[S_DRAFT, 'Recibido', 'draft', 0],
			[S_SENT, 'Enviada', 'sent', 2],
			[S_SIGNED, 'Firmada', 'signed', 3],
		]);
		expect(inserts.map(([, params]) => [(params as unknown[])[1], (params as unknown[])[3], (params as unknown[])[4]])).toEqual([
			['Negociando', 'draft', 1],
			['Contrato creado', 'contract_created', 4],
		]);
		// El orden importa: primero las posiciones negativas, después cada etapa en su posición final.
		const order = runner.query.mock.calls.map(([sql]) => (sql as string).slice(0, 30));

		expect(order.findIndex((sql) => sql.includes('SET position = -1'))).toBeLessThan(
			order.findIndex((sql) => sql.includes('UPDATE quote_stages SET name'))
		);
	});

	it('409 al eliminar una etapa con cotizaciones o de sistema; 400 si una etapa no es del holding o los kinds no cierran', async () => {
		const { service, runner } = build();

		await expect(
			service.replace({ stages: [stage(S_DRAFT, 'Recepcionado', 'draft'), stage(S_SIGNED, 'Firmada', 'signed')] }, 'h-1', 'auth-1')
		).rejects.toMatchObject({
			constructor: ConflictException,
			response: { code: 'stage_in_use', message: expect.stringContaining('"Enviada" tiene 61 cotización(es)') },
		});
		expect(runner.rollbackTransaction).toHaveBeenCalled();
		await expect(
			service.replace(
				{
					stages: [
						stage('99999999-9999-4999-8999-999999999999', 'Ajena', 'draft'),
						...existing.map((row) => stage(String(row.id), String(row.name), String(row.kind))),
					],
				},
				'h-1',
				'auth-1'
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.replace({ stages: [stage(S_SENT, 'Enviada', 'sent')] }, 'h-1', 'auth-1')).rejects.toBeInstanceOf(BadRequestException);
	});
});

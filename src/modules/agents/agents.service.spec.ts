import { ConflictException, NotFoundException } from '@nestjs/common';

import { AgentsService } from './agents.service';

const HOLDING = 'h-1';
const RUN = 'run-1';
const CLIENT = 'client-1';

type Responder = (sql: string, params: unknown[]) => unknown;

/**
 * DataSource falso: cada consulta responde según la primera regla cuyo patrón aparece en el SQL. Como TypeORM sobre Postgres,
 * UPDATE/DELETE devuelven `[filas, rowCount]` (no las filas planas).
 */
function fakeDataSource(rules: Array<[RegExp, Responder | unknown]>) {
	return {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			const rule = rules.find(([pattern]) => pattern.test(sql));
			const rows = !rule ? [] : typeof rule[1] === 'function' ? (rule[1] as Responder)(sql, params) : rule[1];

			return /^\s*(UPDATE|DELETE)\b/i.test(sql) ? [rows, Array.isArray(rows) ? rows.length : 0] : rows;
		}),
	};
}

function build(rules: Array<[RegExp, Responder | unknown]>) {
	const dataSource = fakeDataSource(rules);
	const proforma = {
		process: jest.fn(async () => ({ messages: [], stats: { messages_created: 0, clients_processed: 0, clients_skipped: 0, errors: 0 } })),
	};
	const collections = { process: jest.fn() };
	const emails = { send: jest.fn(async () => undefined) };
	const service = new AgentsService(dataSource as never, proforma as never, collections as never, emails as never);

	return { service, dataSource, proforma, emails };
}

const sqlCalls = (dataSource: { query: jest.Mock }, pattern: RegExp) => dataSource.query.mock.calls.filter(([sql]) => pattern.test(sql));

describe('AgentsService', () => {
	describe('runAgent', () => {
		const agent = { id: 'a-1', type: 'proforma', is_enabled: true, require_approval: true };

		it('preview no deja un run aprobable: queda cancelled con mode preview', async () => {
			const { service, dataSource } = build([
				[/FROM ai_agents WHERE id/, [agent]],
				[/INSERT INTO ai_runs/, [{ id: RUN }]],
			]);

			const result = await service.runAgent('a-1', 'preview', HOLDING);

			expect(result.status).toBe('cancelled');
			const [update] = sqlCalls(dataSource, /UPDATE ai_runs SET status/);

			expect(update[1][0]).toBe('cancelled');
			expect(JSON.parse(update[1][1] as string)).toMatchObject({ mode: 'preview' });
		});

		it('execute con aprobación deja el run queued sin enviar', async () => {
			const { service, emails } = build([
				[/FROM ai_agents WHERE id/, [agent]],
				[/INSERT INTO ai_runs/, [{ id: RUN }]],
			]);

			expect((await service.runAgent('a-1', 'execute', HOLDING)).status).toBe('queued');
			expect(emails.send).not.toHaveBeenCalled();
		});

		it('execute sin aprobación envía y deja el run sent', async () => {
			const { service, proforma, emails } = build([
				[/FROM ai_agents WHERE id/, [{ ...agent, require_approval: false }]],
				[/INSERT INTO ai_runs/, [{ id: RUN }]],
			]);

			proforma.process.mockResolvedValueOnce({
				messages: [{ id: 'm1', to: 'a@b.cl', subject: 's', body: 'cuerpo', meta_json: { from_email: 'x@y.cl', client_id: CLIENT } }],
				stats: { messages_created: 1, clients_processed: 1, clients_skipped: 0, errors: 0 },
			});

			expect((await service.runAgent('a-1', 'execute', HOLDING)).status).toBe('sent');
			expect(emails.send).toHaveBeenCalledTimes(1);
		});
	});

	describe('approveRun', () => {
		const message = { id: 'm1', to: 'a@b.cl', subject: 's', body: 'b', meta_json: { from_email: 'x@y.cl' } };

		it('solo aprueba runs queued (409)', async () => {
			const { service } = build([[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'sent' }]]]);

			await expect(service.approveRun(RUN, HOLDING, 'u-1')).rejects.toBeInstanceOf(ConflictException);
		});

		it('rechaza un run sin mensajes (409)', async () => {
			const { service, emails } = build([
				[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'queued' }]],
				[/FROM ai_messages/, []],
			]);

			await expect(service.approveRun(RUN, HOLDING, 'u-1')).rejects.toThrow('La ejecución no tiene mensajes para enviar');
			expect(emails.send).not.toHaveBeenCalled();
		});

		it('si otra aprobación ganó la carrera responde 409 y no envía', async () => {
			const { service, emails } = build([
				[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'queued' }]],
				[/FROM ai_messages/, [message]],
				[/SET status = 'approved'/, []],
			]);

			await expect(service.approveRun(RUN, HOLDING, 'u-1')).rejects.toBeInstanceOf(ConflictException);
			expect(emails.send).not.toHaveBeenCalled();
		});

		it('guarda quién aprobó, envía y conserva las estadísticas de la generación', async () => {
			const { service, dataSource, emails } = build([
				[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'queued', stats_json: { messages_created: 1, clients_processed: 1 } }]],
				[/FROM ai_messages/, [message]],
				[/SET status = 'approved'/, [{ id: RUN }]],
			]);

			const result = await service.approveRun(RUN, HOLDING, 'u-1');

			expect(result).toMatchObject({ status: 'sent', messages_sent: 1, total_messages: 1 });
			expect(emails.send).toHaveBeenCalledTimes(1);
			expect(sqlCalls(dataSource, /SET status = 'approved'/)[0][1]).toEqual([RUN, HOLDING, 'u-1']);
			const [final] = sqlCalls(dataSource, /UPDATE ai_runs SET status = \$1/);

			expect(JSON.parse(final[1][1] as string)).toMatchObject({ messages_created: 1, clients_processed: 1, messages_sent: 1 });
		});

		it('si ningún correo sale el run queda en error', async () => {
			const { service, emails } = build([
				[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'queued' }]],
				[/FROM ai_messages/, [message]],
				[/SET status = 'approved'/, [{ id: RUN }]],
			]);

			emails.send.mockRejectedValueOnce(new Error('SendGrid caído'));

			expect((await service.approveRun(RUN, HOLDING, 'u-1')).status).toBe('error');
		});
	});

	describe('cancelRun', () => {
		it('descarta un run queued', async () => {
			const { service } = build([[/SET status = 'cancelled'/, [{ id: RUN, status: 'cancelled' }]]]);

			await expect(service.cancelRun(RUN, HOLDING, 'u-1')).resolves.toEqual({ id: RUN, status: 'cancelled' });
		});

		it('409 si no está pendiente y 404 si es de otro holding', async () => {
			const pending = build([[/FROM ai_runs WHERE id/, [{ id: RUN, status: 'sent' }]]]);

			await expect(pending.service.cancelRun(RUN, HOLDING)).rejects.toBeInstanceOf(ConflictException);

			const foreign = build([]);

			await expect(foreign.service.cancelRun(RUN, HOLDING)).rejects.toBeInstanceOf(NotFoundException);
		});
	});

	describe('configuración por cliente', () => {
		it('un cliente de otro holding responde 404 al leer y al guardar', async () => {
			const { service, dataSource } = build([]);

			await expect(service.getClientConfig(CLIENT, 'proforma', HOLDING)).rejects.toBeInstanceOf(NotFoundException);
			await expect(service.updateClientConfig(CLIENT, 'proforma', HOLDING, { is_enabled: true })).rejects.toBeInstanceOf(NotFoundException);
			expect(sqlCalls(dataSource, /INSERT INTO client_agent_configs/)).toHaveLength(0);
		});

		it('sin fila propia devuelve la global con el nombre del cliente', async () => {
			const { service } = build([
				[/FROM clients WHERE id/, [{ id: CLIENT, name_commercial: 'ACME' }]],
				[
					/client_id IS NULL/,
					[{ id: 'g-1', holding_id: HOLDING, agent_type: 'proforma', is_enabled: true, config_json: { days_before_issue: 7 } }],
				],
			]);

			await expect(service.getClientConfig(CLIENT, 'proforma', HOLDING)).resolves.toMatchObject({
				source: 'global',
				client_id: CLIENT,
				client_name: 'ACME',
				config_json: { days_before_issue: 7 },
			});
		});

		it('volver a la global borra la fila propia; 404 si no había', async () => {
			const ok = build([[/DELETE FROM client_agent_configs/, [{ id: 'c-1' }]]]);

			await expect(ok.service.deleteClientConfig(CLIENT, 'proforma', HOLDING)).resolves.toBeUndefined();

			const none = build([]);

			await expect(none.service.deleteClientConfig(CLIENT, 'proforma', HOLDING)).rejects.toBeInstanceOf(NotFoundException);
		});

		it('resumen: conteos por tipo y clientes sin repetir', async () => {
			const { service } = build([
				[
					/FROM client_agent_configs WHERE holding_id = \$1 AND client_id IS NOT NULL/,
					[
						{ client_id: 'c1', agent_type: 'proforma', is_enabled: true },
						{ client_id: 'c1', agent_type: 'collections', is_enabled: false },
						{ client_id: 'c2', agent_type: 'collections', is_enabled: true },
					],
				],
			]);

			await expect(service.clientConfigsSummary(HOLDING)).resolves.toEqual({
				proforma: { total: 1, enabled: 1 },
				collections: { total: 2, enabled: 1 },
				client_ids: ['c1', 'c2'],
			});
		});
	});

	describe('listRuns', () => {
		it('pagina y filtra por holding, tipo y estado', async () => {
			const { service, dataSource } = build([
				[/COUNT\(\*\)::int AS total/, [{ total: 45 }]],
				[/SELECT r\.id/, [{ id: RUN }]],
			]);

			const result = await service.listRuns(HOLDING, { page: 2, limit: 20, type: 'collections', status: 'queued' });

			expect(result).toEqual({ data: [{ id: RUN }], total: 45, currentPage: 2, pages: 3, limit: 20 });
			const [, params] = sqlCalls(dataSource, /SELECT r\.id/)[0];

			expect(params).toEqual([HOLDING, 'collections', 'queued', 20, 20]);
		});
	});
});

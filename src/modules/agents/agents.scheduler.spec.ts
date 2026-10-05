import { AgentsScheduler } from './agents.scheduler';

/**
 * El scheduler de agentes nunca llegó a ejecutar uno: llamaba
 * `runAgent(agent.id, agent.holding_id, 'execute')` contra la firma `runAgent(agentId, mode, holdingId)`.
 * Postgres rechazaba el UUID inválido y el `catch` del bucle se comía el error cada minuto.
 *
 * El primer caso de este spec es la regresión de eso: fija el **orden** de los argumentos.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** `'* * * * *'` hace que `shouldExecuteNow` dé true en cualquier minuto. */
const agentRow = (overrides: Record<string, unknown> = {}) => ({
	id: AGENT,
	type: 'proforma',
	schedule: '* * * * *',
	holding_id: HOLDING,
	auto_execute: true,
	require_approval: false,
	...overrides,
});

function buildScheduler(rows: Array<Record<string, unknown>> = [agentRow()]) {
	const agentsService = { runAgent: jest.fn().mockResolvedValue({ runId: 'run-1' }) };
	const dataSource = { query: jest.fn().mockResolvedValue(rows) };

	const scheduler = new AgentsScheduler(agentsService as never, dataSource as never);
	jest.spyOn(scheduler['logger'], 'log').mockImplementation();
	jest.spyOn(scheduler['logger'], 'debug').mockImplementation();
	jest.spyOn(scheduler['logger'], 'warn').mockImplementation();
	jest.spyOn(scheduler['logger'], 'error').mockImplementation();

	return { scheduler, agentsService, dataSource };
}

describe('AgentsScheduler', () => {
	afterEach(() => jest.restoreAllMocks());

	it('ejecuta el agente con (agentId, mode, holdingId) — el orden que exige runAgent', async () => {
		const { scheduler, agentsService } = buildScheduler();

		await scheduler.checkScheduledAgents();

		expect(agentsService.runAgent).toHaveBeenCalledTimes(1);
		expect(agentsService.runAgent).toHaveBeenCalledWith(AGENT, 'execute', HOLDING);
		// Lo que hacía antes: el holding viajaba en la posición del modo.
		expect(agentsService.runAgent).not.toHaveBeenCalledWith(AGENT, HOLDING, 'execute');
	});

	it('no ejecuta nada si no hay agentes programados', async () => {
		const { scheduler, agentsService } = buildScheduler([]);

		await scheduler.checkScheduledAgents();

		expect(agentsService.runAgent).not.toHaveBeenCalled();
	});

	it('omite el agente cuyo cron no corresponde a este minuto', async () => {
		const otherMinute = (new Date().getMinutes() + 1) % 60;
		const { scheduler, agentsService } = buildScheduler([agentRow({ schedule: `${otherMinute} * * * *` })]);

		await scheduler.checkScheduledAgents();

		expect(agentsService.runAgent).not.toHaveBeenCalled();
	});

	it('ignora un cron mal formado sin romper la corrida', async () => {
		const { scheduler, agentsService } = buildScheduler([agentRow({ schedule: 'no-es-un-cron' })]);

		await expect(scheduler.checkScheduledAgents()).resolves.not.toThrow();
		expect(agentsService.runAgent).not.toHaveBeenCalled();
	});

	it('un agente que falla no aborta a los siguientes', async () => {
		const otherAgent = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
		const { scheduler, agentsService } = buildScheduler([agentRow(), agentRow({ id: otherAgent })]);
		agentsService.runAgent.mockRejectedValueOnce(new Error('Odoo caído'));

		await scheduler.checkScheduledAgents();

		expect(agentsService.runAgent).toHaveBeenCalledTimes(2);
		expect(agentsService.runAgent).toHaveBeenNthCalledWith(2, otherAgent, 'execute', HOLDING);
	});

	it('solo pide agentes habilitados, con auto_execute y con schedule', async () => {
		const { scheduler, dataSource } = buildScheduler();

		await scheduler.checkScheduledAgents();

		const sql = (dataSource.query.mock.calls[0][0] as string).replace(/\s+/g, ' ');
		expect(sql).toContain('is_enabled = true');
		expect(sql).toContain('auto_execute = true');
		expect(sql).toContain('schedule IS NOT NULL');
	});
});

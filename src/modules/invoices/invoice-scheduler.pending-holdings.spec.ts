import { InvoiceSchedulerService } from './invoice-scheduler.service';

// `uuid` publica ESM y Jest no lo transforma.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

/**
 * `getHoldingIdsWithPendingInvoices` es lo que decide qué holdings procesa el cron: los que tienen
 * facturas por emitir **y** no tienen apagada la integración automática de Odoo. El flag se aplica solo
 * aquí — el envío manual sigue siendo la válvula de escape de un holding apagado.
 */
const HOLDING_A = '11111111-1111-4111-8111-111111111111';
const HOLDING_B = '22222222-2222-4222-8222-222222222222';

type Call = [string, ...unknown[]];

function buildService(rows: Array<{ holding_id: string }> = []) {
	const calls: Record<string, Call[]> = { leftJoin: [], andWhere: [], where: [], select: [] };
	const builder: Record<string, unknown> = {
		getRawMany: jest.fn().mockResolvedValue(rows),
		getMany: jest.fn().mockResolvedValue([]),
	};
	for (const method of ['leftJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'select']) {
		builder[method] = jest.fn((...args: unknown[]) => {
			calls[method]?.push(args as Call);
			return builder;
		});
	}

	const invoiceRepository = { createQueryBuilder: jest.fn(() => builder) };
	const args = new Array(18).fill({});
	args[0] = invoiceRepository;

	return {
		service: new InvoiceSchedulerService(...(args as ConstructorParameters<typeof InvoiceSchedulerService>)),
		calls,
		builder,
	};
}

/** Une todas las condiciones del query builder en un solo texto, para buscar dentro. */
const sqlOf = (calls: Record<string, Call[]>) =>
	[...calls.where, ...calls.andWhere, ...calls.leftJoin]
		.map((call) => call.map((part) => (typeof part === 'string' ? part : '')).join(' '))
		.join(' | ');

describe('InvoiceSchedulerService.getHoldingIdsWithPendingInvoices', () => {
	it('devuelve los holdings distintos con facturas pendientes', async () => {
		const { service } = buildService([{ holding_id: HOLDING_A }, { holding_id: HOLDING_B }]);

		await expect(service.getHoldingIdsWithPendingInvoices()).resolves.toEqual([HOLDING_A, HOLDING_B]);
	});

	it('excluye los holdings con la integración automática apagada', async () => {
		const { service, calls } = buildService();

		await service.getHoldingIdsWithPendingInvoices();

		const sql = sqlOf(calls);
		expect(sql).toContain('holding_integration_settings');
		expect(sql).toContain("his.integration = 'odoo'");
		// Fila ausente = habilitado: sin el COALESCE el LEFT JOIN dejaría fuera a todos los holdings
		// que nunca tocaron el interruptor, es decir a todos.
		expect(sql).toContain('COALESCE(his.auto_enabled, true) = true');
	});

	it('conserva los filtros de facturas por emitir', async () => {
		const { service, calls } = buildService();

		await service.getHoldingIdsWithPendingInvoices();

		const sql = sqlOf(calls);
		expect(sql).toContain('inv.status = :status');
		expect(sql).toContain('inv.sent_to_odoo_at IS NULL');
		expect(sql).toContain('com.odoo_integration_id IS NOT NULL');
		expect(sql).toContain('con.auto_send_to_odoo = true');
	});

	it('sin facturas pendientes devuelve una lista vacía y el cron no crea corridas', async () => {
		const { service } = buildService([]);

		await expect(service.getHoldingIdsWithPendingInvoices()).resolves.toEqual([]);
	});

	it('el envío manual no mira el flag: getInvoicesToSend no toca holding_integration_settings', async () => {
		const { service, calls } = buildService();

		await service.getInvoicesToSend(HOLDING_A);

		expect(sqlOf(calls)).not.toContain('holding_integration_settings');
	});
});

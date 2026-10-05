import { SchedulerReportQueryDto } from './dtos/scheduler-report.dto';
import { InvoiceSchedulerService } from './invoice-scheduler.service';

// `uuid` publica ESM y Jest no lo transforma (mismo mock que `invoice-scheduler.service.spec.ts`).
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

/**
 * `getJobsReport` se acota al holding activo. El caso delicado son las corridas del cron, que se
 * guardan con `holdingId: 'all'` y mezclan facturas de todos los clientes: entran al reporte, pero
 * recortadas. Aquí se verifica el pipeline que hace ese recorte (Mongo no corre en unit tests).
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';

type Stage = Record<string, any>;

function buildService(items: Stage[] = [], summaryRows: Stage[] = []) {
	const pipelines: Stage[][] = [];
	const aggregate = jest.fn((pipeline: Stage[]) => {
		pipelines.push(pipeline);
		return { exec: jest.fn().mockResolvedValue(pipelines.length === 1 ? items : summaryRows) };
	});
	const countDocuments = jest.fn(() => ({ exec: jest.fn().mockResolvedValue(items.length) }));
	const jobModel = { aggregate, countDocuments };
	const dataSource = { query: jest.fn().mockResolvedValue([]) };

	const args = new Array(18).fill({});
	args[8] = dataSource;
	args[10] = jobModel;

	return {
		service: new InvoiceSchedulerService(...(args as ConstructorParameters<typeof InvoiceSchedulerService>)),
		pipelines,
		countDocuments,
		dataSource,
	};
}

const query = (overrides: Partial<SchedulerReportQueryDto> = {}): SchedulerReportQueryDto =>
	({ page: 1, limit: 25, ...overrides }) as SchedulerReportQueryDto;

/** Busca en el pipeline la etapa que produce `scopedResults`. */
const scopedResultsCond = (pipeline: Stage[]) => pipeline.find((stage) => stage.$addFields?.scopedResults)?.$addFields.scopedResults.$filter.cond;

describe('InvoiceSchedulerService.getJobsReport (tenancy)', () => {
	it('incluye las corridas del holding y las cross-holding del cron', async () => {
		const { service, pipelines, countDocuments } = buildService();

		await service.getJobsReport(query(), HOLDING);

		const match = pipelines[0][0].$match;
		expect(match.$or).toEqual([{ holdingId: HOLDING }, { holdingId: 'all' }]);
		// Sin las corridas 'all' el reporte quedaría casi vacío: el cron nunca guarda un holding.
		expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({ $or: [{ holdingId: HOLDING }, { holdingId: 'all' }] }));
	});

	it('recorta las facturas de una corrida cross-holding al holding activo', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(query(), HOLDING);

		expect(scopedResultsCond(pipelines[0])).toEqual({
			$or: [{ $ne: ['$holdingId', 'all'] }, { $eq: ['$$result.holdingId', HOLDING] }],
		});
	});

	it('no recorta las corridas de un solo holding, que pueden no traer holdingId por factura', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(query(), HOLDING);

		const [singleHoldingRun] = scopedResultsCond(pipelines[0]).$or;
		expect(singleHoldingRun).toEqual({ $ne: ['$holdingId', 'all'] });
	});

	it('proyecta las facturas y los errores desde lo recortado, nunca desde el documento completo', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(query(), HOLDING);

		const projection = pipelines[0].find((stage) => stage.$project?.invoiceResults)?.$project;
		expect(projection.invoiceResults.$map.input).toBe('$scopedResults');
		expect(projection.errorInvoices.$map.input.$filter.input).toBe('$scopedResults');
		expect(projection.errors.$map.input.$filter.input).toBe('$scopedResults');
		expect(JSON.stringify(projection)).not.toContain('$result.results');
	});

	it('recalcula progress solo en las corridas cross-holding', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(query(), HOLDING);

		const progress = pipelines[0].find((stage) => stage.$addFields?.progress)?.$addFields.progress;
		const [condition, recalculated, untouched] = progress.$cond;
		expect(condition).toEqual({ $eq: ['$holdingId', 'all'] });
		expect(recalculated.total).toEqual({ $size: '$scopedResults' });
		expect(untouched).toBe('$progress');
	});

	it('calcula el resumen sobre lo recortado, no sobre los totales del documento', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(query(), HOLDING);

		const summaryPipeline = pipelines[1];
		expect(summaryPipeline.some((stage) => stage.$addFields?.scopedResults)).toBe(true);
		expect(summaryPipeline.some((stage) => stage.$addFields?.progress)).toBe(true);
	});

	it('aplica los filtros de la query sin aceptar un holding por parámetro', async () => {
		const { service, pipelines } = buildService();

		await service.getJobsReport(
			query({ environment: 'production', source: 'automatic', dryRun: 'false', from: '2026-09-01', to: '2026-09-30' }),
			HOLDING
		);

		const match = pipelines[0][0].$match;
		expect(match.executionEnvironment).toBe('production');
		expect(match.executionSource).toBe('automatic');
		expect(match.dryRun).toBe(false);
		expect(match.startedAt.$gte).toEqual(new Date('2026-09-01T00:00:00.000Z'));
		expect(match.startedAt.$lt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
		expect(match.holdingId).toBeUndefined();
	});
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { InvoiceSchedulerController } from './invoice-scheduler.controller';
import { InvoiceSchedulerService } from './invoice-scheduler.service';

// `uuid` publica ESM y Jest no lo transforma.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

/**
 * `GET /invoices/scheduler/report` es el único endpoint del controlador acotado por holding: el guard
 * va en el método. Los demás los sigue llamando el front viejo y no deben exigir el header.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';

describe('InvoiceSchedulerController (tenancy del reporte)', () => {
	let app: INestApplication;
	const scheduler = {
		getJobsReport: jest.fn(),
		getSchedulerStatus: jest.fn(),
		getRecentJobs: jest.fn(),
	};

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [InvoiceSchedulerController],
			providers: [
				{ provide: InvoiceSchedulerService, useValue: scheduler },
				HoldingScopeGuard,
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) },
				},
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
					context.switchToHttp().getRequest().user = { sub: 'auth-1' };
					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
		await request(app.getHttpServer()).get('/invoices/scheduler/report').expect(400);

		expect(scheduler.getJobsReport).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403', async () => {
		await request(app.getHttpServer()).get('/invoices/scheduler/report').set('x-holding-id', OTHER_HOLDING).expect(403);

		expect(scheduler.getJobsReport).not.toHaveBeenCalled();
	});

	it('entrega al servicio el holding validado del header', async () => {
		scheduler.getJobsReport.mockResolvedValue({ items: [], total: 0, page: 1, limit: 25, summary: {} });

		await request(app.getHttpServer()).get('/invoices/scheduler/report').set('x-holding-id', HOLDING).expect(200);

		expect(scheduler.getJobsReport).toHaveBeenCalledWith(expect.anything(), HOLDING);
	});

	it('rechaza con 403 un holding_id en la query distinto al del header', async () => {
		await request(app.getHttpServer()).get(`/invoices/scheduler/report?holding_id=${OTHER_HOLDING}`).set('x-holding-id', HOLDING).expect(403);

		expect(scheduler.getJobsReport).not.toHaveBeenCalled();
	});

	it('no exige el header en los endpoints que todavía usa el front viejo', async () => {
		scheduler.getSchedulerStatus.mockReturnValue({ enabled: true });

		await request(app.getHttpServer()).get('/invoices/scheduler/status').expect(200);
	});
});

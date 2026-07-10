import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { HealthController } from '../health.controller';

describe('HealthController', () => {
	let controller: HealthController;
	let healthCheckService: { check: jest.Mock };
	let typeOrmHealthIndicator: { pingCheck: jest.Mock };

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			controllers: [HealthController],
			providers: [
				{
					provide: HealthCheckService,
					useValue: {
						check: jest.fn(),
					},
				},
				{
					provide: TypeOrmHealthIndicator,
					useValue: {
						pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
					},
				},
				{
					provide: DataSource,
					useValue: {
						driver: {
							pool: {
								totalCount: 4,
								idleCount: 2,
								waitingCount: 1,
							},
						},
					},
				},
			],
		}).compile();

		controller = module.get<HealthController>(HealthController);
		healthCheckService = module.get(HealthCheckService);
		typeOrmHealthIndicator = module.get(TypeOrmHealthIndicator);
		healthCheckService.check.mockResolvedValue({ status: 'ok' });
	});

	it('HealthController - should be defined', () => {
		expect(controller).toBeDefined();
	});

	it('HealthController - check() should be defined', () => {
		expect(controller.check).toBeDefined();
	});

	it('HealthController - check() should return health check result', async () => {
		const response = await controller.check();

		expect(typeOrmHealthIndicator.pingCheck).not.toHaveBeenCalled();
		expect(healthCheckService.check).toHaveBeenCalledTimes(1);
		expect(response.status).toEqual('ok');
	});

	it('HealthController - checkDatabase() should return pool info', async () => {
		const response = await controller.checkDatabase();

		expect(response).toEqual({
			status: 'ok',
			info: {
				database: {
					status: 'up',
					totalConnections: 4,
					idleConnections: 2,
					waitingRequests: 1,
				},
			},
		});
	});
});

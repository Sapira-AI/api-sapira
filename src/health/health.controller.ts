import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus/';
import { DataSource } from 'typeorm';

import { Public } from '@/decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
@Public()
export class HealthController {
	constructor(
		private readonly health: HealthCheckService,
		private readonly db: TypeOrmHealthIndicator,
		private readonly dataSource: DataSource
	) {}

	@Get()
	@HealthCheck()
	check() {
		return this.health.check([() => this.db.pingCheck('database')]);
	}

	@Get('database')
	@HealthCheck()
	async checkDatabase() {
		const poolInfo = this.getPoolInfo();

		return {
			status: 'ok',
			info: {
				database: {
					status: 'up',
					...poolInfo,
				},
			},
		};
	}

	private getPoolInfo() {
		try {
			const driver = this.dataSource.driver as any;
			const pool = driver?.master || driver?.pool;

			if (pool) {
				return {
					totalConnections: pool.totalCount || pool._count || 0,
					idleConnections: pool.idleCount || pool._idle?.length || 0,
					waitingRequests: pool.waitingCount || pool._pendingAcquires?.length || 0,
				};
			}
		} catch (error) {
			return {
				error: 'No se pudo obtener información del pool',
			};
		}

		return {};
	}
}

import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { ContractsModule } from '@/modules/contracts/contracts.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Tareas del holding (Notificaciones v2 §4): `TasksService` es la única fuente de "Tareas pendientes" para el centro de notificaciones
 * (`GET /notifications/tasks`) y el Dashboard (`DashboardModule` importa este módulo).
 */
@Module({
	imports: [PostgreSQLDatabaseModule, BillingModule, ContractsModule, MetricsModule],
	controllers: [TasksController],
	providers: [TasksService],
	exports: [TasksService],
})
export class TasksModule {}

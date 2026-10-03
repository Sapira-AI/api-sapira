import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { TasksModule } from '@/modules/tasks/tasks.module';

import { MonthCloseService } from './month-close.service';
import { NotificationDigestService } from './notification-digest.service';
import { NotificationJobsController } from './notification-jobs.controller';
import { NotificationJobsScheduler } from './notification-jobs.scheduler';

/**
 * Jobs de Notificaciones v2 fase 2: resumen semanal (`NotificationDigestService`) y aviso de cierre de mes (`MonthCloseService`), con su job
 * horario. Módulo aparte porque leen Tareas y Métricas, y Contratos (que Tareas importa) ya depende de Notificaciones: se evita el ciclo.
 */
@Module({
	imports: [PostgreSQLDatabaseModule, NotificationsModule, TasksModule, MetricsModule],
	controllers: [NotificationJobsController],
	providers: [NotificationDigestService, MonthCloseService, NotificationJobsScheduler],
	exports: [NotificationDigestService, MonthCloseService],
})
export class NotificationJobsModule {}

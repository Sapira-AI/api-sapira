import { Module } from '@nestjs/common';

import { EncryptionService } from '@/common/services/encryption.service';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { FacturaModule } from '@/modules/factura/factura.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { KameClientService } from './kame-client.service';
import { KameConnectionsService } from './kame-connections.service';
import { KameExportService } from './kame-export.service';
import { KameController } from './kame.controller';
import { KameScheduler } from './kame.scheduler';

/**
 * Integración con Kame (ERP contable): registra las facturas emitidas en Sapira y los asientos de devengo (`README.md`). Reutiliza
 * api-factura para el XML del DTE emitido (`FacturaModule`), Métricas para los asientos (`MetricsModule`) y Notificaciones para el aviso
 * de fallo. Los guards vienen de `GuardsModule` (global); `DataSource` y `ConfigService` son globales.
 */
@Module({
	imports: [PostgreSQLDatabaseModule, FacturaModule, MetricsModule, NotificationsModule],
	controllers: [KameController],
	providers: [EncryptionService, KameClientService, KameConnectionsService, KameExportService, KameScheduler],
	exports: [KameConnectionsService, KameExportService],
})
export class KameModule {}

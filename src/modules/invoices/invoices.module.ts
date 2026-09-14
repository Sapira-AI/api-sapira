import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { InvoiceItem } from '@/databases/postgresql/entities/facturacion/invoice-item.entity';
import { InvoiceReference } from '@/databases/postgresql/entities/facturacion/invoice-reference.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';
import { OdooProductMapping } from '@/databases/postgresql/entities/integraciones/odoo/odoo-product-mapping.entity';
import { BancoCentralModule } from '@/modules/banco-central/banco-central.module';
import { EmailsModule } from '@/modules/emails/emails.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { OdooModule } from '@/modules/odoo/odoo.module';

import { InvoiceNotificationService } from './invoice-notification.service';
import { InvoiceSchedulerInitService } from './invoice-scheduler-init.service';
import { InvoiceSchedulerController } from './invoice-scheduler.controller';
import { InvoiceSchedulerGateway } from './invoice-scheduler.gateway';
import { InvoiceSchedulerScheduler } from './invoice-scheduler.scheduler';
import { InvoiceSchedulerService } from './invoice-scheduler.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceOdooSendLog, InvoiceOdooSendLogSchema } from './schemas/invoice-odoo-send-log.schema';
import { InvoiceSchedulerJob, InvoiceSchedulerJobSchema } from './schemas/invoice-scheduler-job.schema';

@Module({
	imports: [
		PostgreSQLDatabaseModule,
		TypeOrmModule.forFeature([Invoice, InvoiceItem, InvoiceReference, Contract, ClientEntity, Company, Product, OdooProductMapping]),
		MongooseModule.forFeature([
			{ name: InvoiceOdooSendLog.name, schema: InvoiceOdooSendLogSchema },
			{ name: InvoiceSchedulerJob.name, schema: InvoiceSchedulerJobSchema },
		]),
		BancoCentralModule,
		OdooModule,
		EmailsModule,
		NotificationsModule,
	],
	controllers: [InvoicesController, InvoiceSchedulerController],
	providers: [
		InvoicesService,
		InvoiceSchedulerService,
		InvoiceSchedulerScheduler,
		InvoiceSchedulerInitService,
		InvoiceNotificationService,
		InvoiceSchedulerGateway,
	],
	exports: [InvoicesService, InvoiceSchedulerService, InvoiceNotificationService],
})
export class InvoicesModule {}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { BancoCentralModule } from '@/modules/banco-central/banco-central.module';
import { EmailsModule } from '@/modules/emails/emails.module';
import { OdooModule } from '@/modules/odoo/odoo.module';

import { Company } from '../odoo/entities/companies.entity';
import { OdooProductMapping } from '../odoo/entities/odoo-product-mapping.entity';
import { Product } from '../odoo/entities/products.entity';

import { Contract } from './entities/contract.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';
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
		TypeOrmModule.forFeature([Invoice, InvoiceItem, Contract, ClientEntity, Company, Product, OdooProductMapping]),
		MongooseModule.forFeature([
			{ name: InvoiceOdooSendLog.name, schema: InvoiceOdooSendLogSchema },
			{ name: InvoiceSchedulerJob.name, schema: InvoiceSchedulerJobSchema },
		]),
		BancoCentralModule,
		OdooModule,
		EmailsModule,
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

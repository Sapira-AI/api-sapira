import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { BancoCentralModule } from '@/modules/banco-central/banco-central.module';
import { EmailsModule } from '@/modules/emails/emails.module';
import { OdooModule } from '@/modules/odoo/odoo.module';

import { Company } from '../odoo/entities/companies.entity';
import { Product } from '../odoo/entities/products.entity';

import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceNotificationService } from './invoice-notification.service';
import { InvoiceSchedulerController } from './invoice-scheduler.controller';
import { InvoiceSchedulerScheduler } from './invoice-scheduler.scheduler';
import { InvoiceSchedulerService } from './invoice-scheduler.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
	imports: [
		PostgreSQLDatabaseModule,
		TypeOrmModule.forFeature([Invoice, InvoiceItem, ClientEntity, Company, Product]),
		BancoCentralModule,
		OdooModule,
		EmailsModule,
	],
	controllers: [InvoicesController, InvoiceSchedulerController],
	providers: [InvoicesService, InvoiceSchedulerService, InvoiceSchedulerScheduler, InvoiceNotificationService],
	exports: [InvoicesService, InvoiceSchedulerService, InvoiceNotificationService],
})
export class InvoicesModule {}

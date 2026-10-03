import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthAccountsModule } from '@/auth/accounts/auth-accounts.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { AppNotificationRecipient } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification-recipient.entity';
import { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import { NotificationRoleSubscription } from '@/databases/postgresql/entities/automatizaciones-ia/notification-role-subscription.entity';
import { UserHolding } from '@/databases/postgresql/entities/base-tenancy/user-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

import { NotificationEmailService } from './notification-email.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';

@Module({
	imports: [
		PostgreSQLDatabaseModule,
		AuthAccountsModule,
		TypeOrmModule.forFeature([AppNotification, AppNotificationRecipient, NotificationRoleSubscription, User, UserHolding]),
	],
	controllers: [NotificationsController],
	providers: [NotificationsService, NotificationsGateway, NotificationEmailService],
	exports: [NotificationsService, NotificationEmailService],
})
export class NotificationsModule {}

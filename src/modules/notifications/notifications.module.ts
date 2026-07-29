import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { UserHolding } from '@/modules/holdings/entities/user-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

import { AppNotification } from './entities/app-notification.entity';
import { AppNotificationRecipient } from './entities/app-notification-recipient.entity';
import { NotificationRoleSubscription } from './entities/notification-role-subscription.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
	imports: [
		PostgreSQLDatabaseModule,
		TypeOrmModule.forFeature([AppNotification, AppNotificationRecipient, NotificationRoleSubscription, User, UserHolding]),
	],
	controllers: [NotificationsController],
	providers: [NotificationsService],
	exports: [NotificationsService],
})
export class NotificationsModule {}

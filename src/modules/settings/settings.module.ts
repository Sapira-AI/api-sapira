import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { AccountingPeriodsService } from './accounting-periods.service';
import { CompanyLegalDocumentsService } from './company-legal-documents.service';
import { CountriesController } from './countries.controller';
import { SettingsAccessController } from './settings-access.controller';
import { SettingsCatalogsController } from './settings-catalogs.controller';
import { SettingsCatalogsService } from './settings-catalogs.service';
import { SettingsCompaniesController } from './settings-companies.controller';
import { SettingsCompaniesService } from './settings-companies.service';
import { SettingsCustomFieldsController } from './settings-custom-fields.controller';
import { SettingsCustomFieldsService } from './settings-custom-fields.service';
import { SettingsHoldingController } from './settings-holding.controller';
import { SettingsHoldingService } from './settings-holding.service';
import { SettingsRolesService } from './settings-roles.service';
import { SettingsStorageService } from './settings-storage.service';
import { SettingsUsersService } from './settings-users.service';

/**
 * Configuración v2 (`docs/v2-rediseno/spec-configuracion-v2.md`, contrato en `contrato-api-configuracion.md`): Holding 360, catálogos,
 * campos personalizados, Compañía 360 (cuentas, bancos, documentos, cierre de períodos), usuarios y roles, y el catálogo global de
 * países. Todo controlador con `HoldingScopeGuard` + `RequirePermissionGuard` (salvo países, global). Los guards vienen de
 * `GuardsModule` (global); `NotificationsModule` aporta las suscripciones de alertas por rol.
 */
@Module({
	imports: [PostgreSQLDatabaseModule, NotificationsModule],
	controllers: [
		SettingsHoldingController,
		SettingsCatalogsController,
		SettingsCustomFieldsController,
		SettingsCompaniesController,
		SettingsAccessController,
		CountriesController,
	],
	providers: [
		SettingsStorageService,
		SettingsHoldingService,
		SettingsCatalogsService,
		SettingsCustomFieldsService,
		SettingsCompaniesService,
		CompanyLegalDocumentsService,
		AccountingPeriodsService,
		SettingsUsersService,
		SettingsRolesService,
	],
})
export class SettingsModule {}

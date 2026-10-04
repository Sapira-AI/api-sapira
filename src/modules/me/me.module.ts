import { Module } from '@nestjs/common';

import { AuthAccountsModule } from '@/auth/accounts/auth-accounts.module';
import { SettingsStorageService } from '@/modules/settings/settings-storage.service';

import { MeController } from './me.controller';
import { MeService } from './me.service';

/**
 * Mi perfil (`/me/*`, contrato `docs/v2-rediseno/contrato-api-mi-perfil.md`). `SettingsStorageService` se reutiliza como provider propio
 * (solo depende de `ConfigService`) para firmar subidas y verificar/borrar objetos; `AuthAccountsModule` aporta `SupabaseAdminService`.
 * `DataSource` viene de `TypeOrmModule.forRoot` (global).
 */
@Module({
	imports: [AuthAccountsModule],
	controllers: [MeController],
	providers: [MeService, SettingsStorageService],
})
export class MeModule {}

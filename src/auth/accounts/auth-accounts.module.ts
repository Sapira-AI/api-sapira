import { Module } from '@nestjs/common';

import { AuthMailer } from './auth-mailer';
import { PasswordRecoveryService } from './password-recovery.service';
import { SupabaseAdminService } from './supabase-admin.service';

/**
 * Cuentas de Supabase Auth administradas por la API: `SupabaseAdminService` (clave de servicio) y `AuthMailer` (correos de invitación y
 * recuperar contraseña con la marca). Lo importan `AuthModule` (`POST /auth/password-recovery`) y `SettingsModule` (usuarios).
 */
@Module({
	providers: [SupabaseAdminService, AuthMailer, PasswordRecoveryService],
	exports: [SupabaseAdminService, AuthMailer, PasswordRecoveryService],
})
export class AuthAccountsModule {}

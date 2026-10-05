import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';

import { AuthAccountsModule } from './accounts/auth-accounts.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RecaptchaService } from './services/recaptcha.service';
import { SupabaseAuthGuard } from './strategies/supabase-auth.guard';

@Module({
	imports: [AuditModule, AuthAccountsModule],
	controllers: [AuthController],
	providers: [AuthService, RecaptchaService, SupabaseAuthGuard],
	exports: [SupabaseAuthGuard, RecaptchaService],
})
export class AuthModule {}

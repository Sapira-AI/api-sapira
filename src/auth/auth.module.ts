import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';

import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './strategies/supabase-auth.guard';

@Module({
	imports: [AuditModule],
	controllers: [],
	providers: [AuthService, SupabaseAuthGuard],
	exports: [SupabaseAuthGuard],
})
export class AuthModule {}

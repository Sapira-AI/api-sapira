import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { AuditModule } from '../audit/audit.module';

import { AuthService } from './auth.service';
import { AzureADAuthGuard } from './strategies/azuread-auth.guard';
import { AzureADStrategy } from './strategies/azuread.strategy';
import { SupabaseAuthGuard } from './strategies/supabase-auth.guard';
import { SupabaseStrategy } from './strategies/supabase.strategy';

@Module({
	imports: [PassportModule.register({ defaultStrategy: 'azure-ad' }), AuditModule],
	controllers: [],
	providers: [AzureADStrategy, AuthService, AzureADAuthGuard, SupabaseStrategy, SupabaseAuthGuard],
	exports: [AzureADAuthGuard, SupabaseAuthGuard],
})
export class AuthModule {}

import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserHolding } from '@/databases/postgresql/entities/base-tenancy/user-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

import { HoldingAccessGuard } from './holding-access.guard';
import { HoldingScopeGuard } from './holding-scope.guard';
import { PermissionsService } from './permissions.service';
import { RequirePermissionGuard } from './require-permission.guard';
import { SuperAdminOnlyGuard } from './super-admin-only.guard';
import { UserHoldingsService } from './user-holdings.service';

/**
 * Módulo global para guards de la aplicación
 * Al ser @Global(), los guards estarán disponibles en toda la aplicación.
 * `HoldingScopeGuard` es la única forma de acotar por holding (docs/v2-rediseno/autorizacion-y-tenancy.md);
 * `RequirePermissionGuard` + `@RequirePermission(...)` exigen permisos por rol en el holding activo (va después de `HoldingScopeGuard`).
 * `HoldingAccessGuard` queda deprecado y no se usa en código nuevo.
 */
@Global()
@Module({
	imports: [TypeOrmModule.forFeature([UserHolding, User])],
	providers: [HoldingAccessGuard, HoldingScopeGuard, UserHoldingsService, PermissionsService, RequirePermissionGuard, SuperAdminOnlyGuard],
	exports: [HoldingAccessGuard, HoldingScopeGuard, UserHoldingsService, PermissionsService, RequirePermissionGuard, SuperAdminOnlyGuard],
})
export class GuardsModule {}

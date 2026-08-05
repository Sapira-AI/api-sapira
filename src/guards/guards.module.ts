import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserHolding } from '../modules/holdings/entities/user-holding.entity';
import { User } from '../modules/users/entities/user.entity';

import { HoldingAccessGuard } from './holding-access.guard';

/**
 * Módulo global para guards de la aplicación
 * Al ser @Global(), los guards estarán disponibles en toda la aplicación
 */
@Global()
@Module({
	imports: [TypeOrmModule.forFeature([UserHolding, User])],
	providers: [HoldingAccessGuard],
	exports: [HoldingAccessGuard],
})
export class GuardsModule {}

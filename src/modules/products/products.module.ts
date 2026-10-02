import { Module } from '@nestjs/common';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/** Productos de Precios v2 (`docs/v2-rediseno/contrato-api-configuracion.md` §6). Requiere la migración M3 (`products.status`). */
@Module({
	imports: [PostgreSQLDatabaseModule],
	controllers: [ProductsController],
	providers: [ProductsService],
	exports: [ProductsService],
})
export class ProductsModule {}

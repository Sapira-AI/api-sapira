import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { SiiCaf, SiiCertificate, SiiConfiguration } from '@/databases/postgresql/entities/sii/sii.entity';
import { FacturaModule } from '@/modules/factura/factura.module';

import { SiiController } from './sii.controller';
import { SiiService } from './sii.service';

@Module({
	imports: [FacturaModule, TypeOrmModule.forFeature([Company, SiiConfiguration, SiiCertificate, SiiCaf])],
	controllers: [SiiController],
	providers: [SiiService],
	exports: [SiiService],
})
export class SiiModule {}

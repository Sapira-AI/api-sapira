import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/modules/odoo/entities/companies.entity';

import { SiiCaf, SiiCertificate, SiiConfiguration } from './entities/sii.entity';
import { SiiController } from './sii.controller';
import { SiiService } from './sii.service';

@Module({
	imports: [TypeOrmModule.forFeature([Company, SiiConfiguration, SiiCertificate, SiiCaf])],
	controllers: [SiiController],
	providers: [SiiService],
	exports: [SiiService],
})
export class SiiModule {}

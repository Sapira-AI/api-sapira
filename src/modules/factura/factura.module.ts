import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { DteSimulation } from '@/databases/postgresql/entities/facturacion/dte-simulation.entity';

import { FacturaClientService } from './factura-client.service';
import { FacturaOAuthService } from './factura-oauth.service';
import { FacturaSimuladaService } from './factura-simulada.service';

@Module({
	imports: [TypeOrmModule.forFeature([DteSimulation, Company])],
	providers: [FacturaOAuthService, FacturaSimuladaService, FacturaClientService],
	exports: [FacturaClientService],
})
export class FacturaModule {}

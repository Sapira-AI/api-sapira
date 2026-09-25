import { Body, Controller, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { CreateCafDto, IntegrateFacturaDto, ReserveFolioDto, UpdateSiiConfigurationDto } from './dtos/sii.dto';
import { SiiService } from './sii.service';

@ApiTags('Configuración SII')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@Controller('sii')
export class SiiController {
	constructor(private readonly sii: SiiService) {}

	@Get('companies')
	@ApiOperation({ summary: 'Listar razones sociales chilenas del holding activo' })
	companies(@HoldingId() holdingId: string) {
		return this.sii.eligibleCompanies(holdingId);
	}

	@Post('companies/:companyId/factura-integration')
	@ApiOperation({ summary: 'Provisionar una compañía del holding en api-factura' })
	integrate(@Param('companyId') companyId: string, @Body() dto: IntegrateFacturaDto, @HoldingId() holdingId: string) {
		return this.sii.integrateWithFactura(holdingId, companyId, dto);
	}

	@Get('companies/:companyId')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: configuración SII vive en api-factura' })
	configuration(@Param('companyId') companyId: string, @HoldingId() holdingId: string) {
		return this.sii.getConfiguration(holdingId, companyId);
	}

	@Patch('companies/:companyId')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: configuración SII vive en api-factura' })
	update(@Param('companyId') companyId: string, @Body() dto: UpdateSiiConfigurationDto, @HoldingId() holdingId: string) {
		return this.sii.updateConfiguration(holdingId, companyId, dto);
	}

	@Post('companies/:companyId/certificate')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: certificado SII se carga en api-factura' })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	certificate(
		@Param('companyId') companyId: string,
		@UploadedFile() file: Express.Multer.File,
		@Body('password') password: string,
		@HoldingId() holdingId: string,
		@Body('expires_at') expiresAt?: string
	) {
		return this.sii.uploadCertificate(holdingId, companyId, file, password, expiresAt);
	}

	@Post('companies/:companyId/cafs')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: CAF se carga en api-factura' })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	caf(@Param('companyId') companyId: string, @Body() dto: CreateCafDto, @UploadedFile() file: Express.Multer.File, @HoldingId() holdingId: string) {
		return this.sii.uploadCaf(holdingId, companyId, dto, file);
	}

	@Post('folios/reserve')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: folios se reservan en api-factura' })
	reserve(@Body() dto: ReserveFolioDto, @HoldingId() holdingId: string) {
		return this.sii.reserveFolio(holdingId, dto);
	}
}

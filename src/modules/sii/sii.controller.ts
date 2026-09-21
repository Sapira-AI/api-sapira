import { Body, Controller, Get, Param, Patch, Post, Request, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CreateCafDto, IntegrateFacturaDto, ReserveFolioDto, UpdateSiiConfigurationDto } from './dtos/sii.dto';
import { SiiService } from './sii.service';

@ApiTags('Configuración SII')
@ApiBearerAuth()
@Controller('sii')
export class SiiController {
	constructor(private readonly sii: SiiService) {}

	@Get('companies')
	@ApiOperation({ summary: 'Listar razones sociales chilenas del holding seleccionado' })
	companies(@Request() request) {
		return this.sii.eligibleCompanies(request.user.id || request.user.sub);
	}

	@Post('companies/:companyId/factura-integration')
	@ApiOperation({ summary: 'Provisionar una compañía del holding en api-factura' })
	integrate(@Request() request, @Param('companyId') companyId: string, @Body() dto: IntegrateFacturaDto) {
		return this.sii.integrateWithFactura(request.user.id || request.user.sub, companyId, dto);
	}

	@Get('companies/:companyId')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: configuración SII vive en api-factura' })
	configuration(@Request() request, @Param('companyId') companyId: string) {
		return this.sii.getConfiguration(request.user.id || request.user.sub, companyId);
	}

	@Patch('companies/:companyId')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: configuración SII vive en api-factura' })
	update(@Request() request, @Param('companyId') companyId: string, @Body() dto: UpdateSiiConfigurationDto) {
		return this.sii.updateConfiguration(request.user.id || request.user.sub, companyId, dto);
	}

	@Post('companies/:companyId/certificate')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: certificado SII se carga en api-factura' })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	certificate(
		@Request() request,
		@Param('companyId') companyId: string,
		@UploadedFile() file: Express.Multer.File,
		@Body('password') password: string,
		@Body('expires_at') expiresAt?: string
	) {
		return this.sii.uploadCertificate(request.user.id || request.user.sub, companyId, file, password, expiresAt);
	}

	@Post('companies/:companyId/cafs')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: CAF se carga en api-factura' })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	caf(@Request() request, @Param('companyId') companyId: string, @Body() dto: CreateCafDto, @UploadedFile() file: Express.Multer.File) {
		return this.sii.uploadCaf(request.user.id || request.user.sub, companyId, dto, file);
	}

	@Post('folios/reserve')
	@ApiOperation({ deprecated: true, summary: 'Deprecated: folios se reservan en api-factura' })
	reserve(@Request() request, @Body() dto: ReserveFolioDto) {
		return this.sii.reserveFolio(request.user.id || request.user.sub, dto);
	}
}

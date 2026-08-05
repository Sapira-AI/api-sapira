import { Body, Controller, Get, Param, Patch, Post, Request, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';

import { CreateCafDto, ReserveFolioDto, UpdateSiiConfigurationDto } from './dtos/sii.dto';
import { SiiService } from './sii.service';

@ApiTags('Configuración SII')
@ApiBearerAuth()
@Controller('sii')
export class SiiController {
	constructor(private readonly sii: SiiService) {}

	@Get('companies')
	companies(@Request() request) {
		return this.sii.eligibleCompanies(request.user.id || request.user.sub);
	}

	@Get('companies/:companyId')
	configuration(@Request() request, @Param('companyId') companyId: string) {
		return this.sii.getConfiguration(request.user.id || request.user.sub, companyId);
	}

	@Patch('companies/:companyId')
	update(@Request() request, @Param('companyId') companyId: string, @Body() dto: UpdateSiiConfigurationDto) {
		return this.sii.updateConfiguration(request.user.id || request.user.sub, companyId, dto);
	}

	@Post('companies/:companyId/certificate')
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	certificate(@Request() request, @Param('companyId') companyId: string, @UploadedFile() file: Express.Multer.File, @Body('password') password: string, @Body('expires_at') expiresAt?: string) {
		return this.sii.uploadCertificate(request.user.id || request.user.sub, companyId, file, password, expiresAt);
	}

	@Post('companies/:companyId/cafs')
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(FileInterceptor('file'))
	caf(@Request() request, @Param('companyId') companyId: string, @Body() dto: CreateCafDto, @UploadedFile() file: Express.Multer.File) {
		return this.sii.uploadCaf(request.user.id || request.user.sub, companyId, dto, file);
	}

	@Post('folios/reserve')
	reserve(@Request() request, @Body() dto: ReserveFolioDto) {
		return this.sii.reserveFolio(request.user.id || request.user.sub, dto);
	}
}

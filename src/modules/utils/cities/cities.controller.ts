import { Body, Controller, Get, HttpStatus, Param, Patch, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExcludeController, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateWriteOpResult } from 'mongoose';

import { AzureADAuthGuard } from '@/auth/strategies/azuread-auth.guard';
import { Public } from '@/decorators/public.decorator';
import { ResponseDTO } from '@/modules/response.dto';

import { CitiesDTO, DistrictDTO, RegionDTO, RegionUpdateDTO } from './cities.dto';
import { CitiesService } from './cities.service';

@ApiExcludeController()
@ApiTags('Utils')
@Controller('cities')
@UseGuards(AzureADAuthGuard)
@ApiBearerAuth()
export class CitiesController {
	constructor(private readonly citiesService: CitiesService) {}

	@Get('/regions')
	@Public()
	@ApiOperation({ summary: 'Obtener Regiones' })
	@ApiOkResponse({ type: ResponseDTO, description: 'Regiones encontradas' })
	async getRegions(@Res() res): Promise<ResponseDTO<RegionDTO>> {
		try {
			const regions = await this.citiesService.getRegions();

			return res.status(HttpStatus.OK).json({
				status: HttpStatus.OK,
				message: 'Regiones encontradas',
				data: regions,
			});
		} catch (error) {
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				message: 'Regiones no encontradas, favor contactar al administrador',
				error: error.message,
			});
		}
	}

	@Patch('/regions/:code_reg')
	@ApiOperation({ summary: 'Actualizar Regiones' })
	@ApiBody({ type: RegionUpdateDTO, required: true, description: 'Objeto para editar una región' })
	@ApiOkResponse({ type: ResponseDTO, description: 'Región actualizadas' })
	async updateRegions(@Res() res, @Param('code_reg') code_reg: string, @Body() body: RegionUpdateDTO): Promise<ResponseDTO<UpdateWriteOpResult>> {
		try {
			const updatedRegion = await this.citiesService.updateRegion(code_reg, body);

			return res.status(HttpStatus.OK).json({
				status: HttpStatus.OK,
				message: 'Regiones editadas',
				data: updatedRegion,
			});
		} catch (error) {
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				message: 'Regiones no editadas, favor contactar al administrador',
				error: error.message,
			});
		}
	}

	@Get('/districts/:code_reg')
	@Public()
	@ApiOperation({ summary: 'Obtener Comunas' })
	@ApiOkResponse({ type: ResponseDTO, description: 'Comunas encontradas' })
	async getDistricts(@Res() res, @Param('code_reg') code_reg: string): Promise<ResponseDTO<DistrictDTO>> {
		try {
			const districts = await this.citiesService.getDistricts(code_reg);

			return res.status(HttpStatus.OK).json({
				status: HttpStatus.OK,
				message: 'Comunas encontradas',
				data: districts,
			});
		} catch (error) {
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				message: 'Comunas no encontradas, favor contactar al administrador',
				error: error.message,
			});
		}
	}

	@Get('/districts-and-regions')
	@Public()
	@ApiOperation({ summary: 'Obtener Comunas' })
	@ApiOkResponse({ type: ResponseDTO, description: 'Comunas y regiones encontradas' })
	async getDistrictsAndRegions(@Res() res): Promise<ResponseDTO<CitiesDTO>> {
		try {
			const districts = await this.citiesService.getDistrictsAndRegions();

			return res.status(HttpStatus.OK).json({
				status: HttpStatus.OK,
				message: 'Comunas encontradas',
				data: districts,
			});
		} catch (error) {
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				message: 'Comunas no encontradas, favor contactar al administrador',
				error: error.message,
			});
		}
	}
}

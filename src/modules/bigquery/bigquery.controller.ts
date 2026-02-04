import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BigQueryService } from './bigquery.service';
import { QueryDto } from './dtos/query.dto';
import { BigQueryResult } from './interfaces/bigquery-result.interface';
import { ProjectInfo } from './interfaces/project-info.interface';

@ApiTags('BigQuery')
@Controller('bigquery')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class BigQueryController {
	constructor(private readonly bigQueryService: BigQueryService) {}

	@Get('project-info')
	@ApiOperation({
		summary: 'Obtener información del proyecto de BigQuery',
		description:
			'Retorna la información de configuración del proyecto de BigQuery, incluyendo el ID del proyecto, ' +
			'el email de la cuenta de servicio y el estado de configuración. Este endpoint es útil para ' +
			'verificar que las credenciales de BigQuery están correctamente configuradas.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Información del proyecto obtenida exitosamente',
		schema: {
			example: {
				projectId: 'datawarehouse-a2e2',
				clientEmail: 'bigquery-service@datawarehouse-a2e2.iam.gserviceaccount.com',
				isConfigured: true,
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	@ApiResponse({
		status: HttpStatus.INTERNAL_SERVER_ERROR,
		description: 'Error al obtener la información del proyecto',
	})
	@HttpCode(HttpStatus.OK)
	async getProjectInfo(): Promise<ProjectInfo> {
		return this.bigQueryService.getProjectInfo();
	}

	@Post('query')
	@ApiOperation({
		summary: 'Ejecutar consulta SQL en BigQuery',
		description:
			'Ejecuta una consulta SQL personalizada en BigQuery y retorna los resultados. ' +
			'Soporta consultas SELECT, INSERT, UPDATE, DELETE y otras operaciones SQL estándar. ' +
			'Los resultados incluyen las filas retornadas, el total de filas y el esquema de la tabla.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Consulta ejecutada exitosamente',
		schema: {
			example: {
				rows: [
					{ id: 1, name: 'Ejemplo 1', amount: 100.5 },
					{ id: 2, name: 'Ejemplo 2', amount: 250.75 },
				],
				totalRows: 2,
				schema: [
					{ name: 'id', type: 'INTEGER' },
					{ name: 'name', type: 'STRING' },
					{ name: 'amount', type: 'FLOAT' },
				],
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Consulta SQL inválida, sintaxis incorrecta o BigQuery no configurado correctamente',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	@ApiResponse({
		status: HttpStatus.INTERNAL_SERVER_ERROR,
		description: 'Error interno al ejecutar la consulta en BigQuery',
	})
	@HttpCode(HttpStatus.OK)
	async executeQuery(@Body() dto: QueryDto): Promise<BigQueryResult> {
		return this.bigQueryService.executeQuery(dto);
	}

	@Get('datasets')
	@ApiOperation({
		summary: 'Obtener lista de datasets',
		description:
			'Retorna la lista de todos los datasets disponibles en el proyecto de BigQuery configurado. ' +
			'Un dataset es un contenedor de nivel superior que organiza y controla el acceso a las tablas y vistas. ' +
			'Este endpoint es útil para explorar la estructura de datos disponible.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de datasets obtenida exitosamente',
		schema: {
			example: ['finance', 'marketing', 'sales', 'analytics'],
		},
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	@ApiResponse({
		status: HttpStatus.INTERNAL_SERVER_ERROR,
		description: 'Error al obtener los datasets de BigQuery',
	})
	@HttpCode(HttpStatus.OK)
	async getDatasets(): Promise<string[]> {
		return this.bigQueryService.getDatasets();
	}

	@Get('datasets/:datasetId/tables')
	@ApiOperation({
		summary: 'Obtener tablas de un dataset',
		description:
			'Retorna la lista de todas las tablas y vistas disponibles en un dataset específico. ' +
			'Las tablas son donde se almacenan los datos en BigQuery. Este endpoint permite explorar ' +
			'qué tablas están disponibles para consultar dentro de un dataset determinado.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de tablas obtenida exitosamente',
		schema: {
			example: ['sapira', 'invoices', 'customers', 'transactions', 'products'],
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'El dataset especificado no existe o no es accesible',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	@ApiResponse({
		status: HttpStatus.INTERNAL_SERVER_ERROR,
		description: 'Error al obtener las tablas del dataset',
	})
	@HttpCode(HttpStatus.OK)
	async getTables(@Param('datasetId') datasetId: string): Promise<string[]> {
		return this.bigQueryService.getTables(datasetId);
	}
}

import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { Public } from '@/decorators/public.decorator';

import { AnalyzeTableDTO, ListTablesDTO } from './database-analyzer.dto';
import { DatabaseAnalyzerService, TableAnalysisResult } from './database-analyzer.service';

@ApiTags('Database Analyzer')
@Controller('database')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class DatabaseAnalyzerController {
	constructor(private readonly databaseAnalyzerService: DatabaseAnalyzerService) {}

	@Post('analyze-table')
	@ApiOperation({
		summary: 'Analizar tabla completa',
		description:
			'Obtiene información completa de una tabla: columnas, índices, llaves foráneas, triggers, políticas RLS, estadísticas, tamaño y permisos',
	})
	@ApiBody({ type: AnalyzeTableDTO })
	@ApiOkResponse({
		description: 'Análisis de tabla completado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				data: {
					type: 'object',
					properties: {
						table_name: { type: 'string' },
						schema_name: { type: 'string' },
						columns: { type: 'array' },
						indexes: { type: 'array' },
						foreign_keys: { type: 'array' },
						primary_unique_keys: { type: 'array' },
						triggers: { type: 'array' },
						policies: { type: 'array' },
						statistics: { type: 'array' },
						size_info: { type: 'object' },
						permissions: { type: 'array' },
						analysis_timestamp: { type: 'string' },
					},
				},
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Tabla no encontrada o error en el análisis' })
	@Public()
	async analyzeTable(@Body() body: AnalyzeTableDTO): Promise<{
		success: boolean;
		message: string;
		data: TableAnalysisResult;
	}> {
		const { table_name, schema_name = 'public' } = body;

		// Verificar que la tabla existe
		const tableExists = await this.databaseAnalyzerService.tableExists(table_name, schema_name);
		if (!tableExists) {
			throw new Error(`La tabla ${schema_name}.${table_name} no existe`);
		}

		// Analizar la tabla
		const analysisResult = await this.databaseAnalyzerService.analyzeTable(table_name, schema_name);

		return {
			success: true,
			message: `Análisis de tabla ${schema_name}.${table_name} completado exitosamente`,
			data: analysisResult,
		};
	}

	@Get('list-tables')
	@ApiOperation({
		summary: 'Listar todas las tablas',
		description: 'Obtiene una lista de todas las tablas disponibles en un esquema',
	})
	@ApiQuery({
		name: 'schema_name',
		description: 'Esquema de la base de datos',
		required: false,
		example: 'public',
	})
	@ApiOkResponse({
		description: 'Lista de tablas obtenida exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				data: {
					type: 'object',
					properties: {
						schema_name: { type: 'string' },
						tables: {
							type: 'array',
							items: { type: 'string' },
						},
						total_tables: { type: 'number' },
					},
				},
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Error obteniendo lista de tablas' })
	@Public()
	async listTables(@Query() query: ListTablesDTO): Promise<{
		success: boolean;
		message: string;
		data: {
			schema_name: string;
			tables: string[];
			total_tables: number;
		};
	}> {
		const { schema_name = 'public' } = query;

		const tables = await this.databaseAnalyzerService.listTables(schema_name);

		return {
			success: true,
			message: `Se encontraron ${tables.length} tablas en el esquema ${schema_name}`,
			data: {
				schema_name,
				tables,
				total_tables: tables.length,
			},
		};
	}

	@Get('table-exists')
	@ApiOperation({
		summary: 'Verificar si una tabla existe',
		description: 'Verifica si una tabla específica existe en el esquema',
	})
	@ApiQuery({ name: 'table_name', description: 'Nombre de la tabla', required: true })
	@ApiQuery({
		name: 'schema_name',
		description: 'Esquema de la base de datos',
		required: false,
		example: 'public',
	})
	@ApiOkResponse({
		description: 'Verificación completada',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				data: {
					type: 'object',
					properties: {
						table_name: { type: 'string' },
						schema_name: { type: 'string' },
						exists: { type: 'boolean' },
					},
				},
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	@Public()
	async tableExists(
		@Query('table_name') tableName: string,
		@Query('schema_name') schemaName: string = 'public'
	): Promise<{
		success: boolean;
		message: string;
		data: {
			table_name: string;
			schema_name: string;
			exists: boolean;
		};
	}> {
		if (!tableName) {
			throw new Error('El parámetro table_name es requerido');
		}

		const exists = await this.databaseAnalyzerService.tableExists(tableName, schemaName);

		return {
			success: true,
			message: `Verificación completada para ${schemaName}.${tableName}`,
			data: {
				table_name: tableName,
				schema_name: schemaName,
				exists,
			},
		};
	}
}

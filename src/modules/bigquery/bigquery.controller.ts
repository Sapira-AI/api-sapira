import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { SapiraQuantityImport } from '@/databases/postgresql/entities/facturacion/sapira-quantity-import.entity';

import { BigQueryService } from './bigquery.service';
import { ListQuantityImportsDto } from './dtos/list-quantity-imports.dto';
import { INTEGRATE_QUANTITIES_EXAMPLES, IntegrateQuantitiesDto, QUANTITIES_RANGE_EXAMPLES, QuantitiesRangeDto } from './dtos/quantities-range.dto';
import { QueryDto } from './dtos/query.dto';
import { ReplaceQuantityRecordDto } from './dtos/replace-quantity-record.dto';
import { SyncStripeCustomersRequestDto, SyncStripeCustomersResponseDto } from './dtos/sync-stripe-customers.dto';
import { BigQueryResult } from './interfaces/bigquery-result.interface';
import { ProjectInfo } from './interfaces/project-info.interface';
import { QuantityRecord } from './interfaces/quantity-record.interface';
import {
	QuantitiesIngestResult,
	QuantitiesIntegrationResult,
	SapiraQuantitiesSyncResult,
} from './interfaces/sapira-quantities-sync-result.interface';

const HOLDING_ID_HEADER = {
	name: 'x-holding-id',
	required: true,
	description: 'Identificador del holding cuya conexión de BigQuery se usará',
};

@ApiTags('BigQuery')
@Controller('bigquery')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class BigQueryController {
	constructor(private readonly bigQueryService: BigQueryService) {}

	private requireHoldingId(holdingId: string): string {
		if (!holdingId) {
			throw new BadRequestException('El header x-holding-id es requerido');
		}

		return holdingId;
	}

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
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async getProjectInfo(@Headers('x-holding-id') holdingId: string): Promise<ProjectInfo> {
		return this.bigQueryService.getProjectInfo(this.requireHoldingId(holdingId));
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
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async executeQuery(@Body() dto: QueryDto, @Headers('x-holding-id') holdingId: string): Promise<BigQueryResult> {
		return this.bigQueryService.executeQuery(this.requireHoldingId(holdingId), dto);
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
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async getDatasets(@Headers('x-holding-id') holdingId: string): Promise<string[]> {
		return this.bigQueryService.getDatasets(this.requireHoldingId(holdingId));
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
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async getTables(@Param('datasetId') datasetId: string, @Headers('x-holding-id') holdingId: string): Promise<string[]> {
		return this.bigQueryService.getTables(this.requireHoldingId(holdingId), datasetId);
	}

	@Post('sync-stripe-customers')
	@ApiOperation({
		summary: 'Sincronizar clientes Stripe desde BigQuery a Supabase',
		description:
			'Consulta la tabla completa `datawarehouse-a2e2.finance.sapira_stripe` desde BigQuery y ' +
			'persiste los datos en Supabase. Realiza un upsert inteligente basado en la combinación de ' +
			'holding_id, salesforce_account_id y stripe_customer_id. Los registros existentes se actualizan ' +
			'y los nuevos se insertan.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada exitosamente',
		type: SyncStripeCustomersResponseDto,
		schema: {
			example: {
				totalProcessed: 150,
				inserted: 50,
				updated: 100,
				message: 'Sincronización completada exitosamente',
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'BigQuery no está configurado correctamente o el holdingId es inválido',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	@ApiResponse({
		status: HttpStatus.INTERNAL_SERVER_ERROR,
		description: 'Error interno al sincronizar datos',
	})
	@HttpCode(HttpStatus.OK)
	async syncStripeCustomers(@Body() dto: SyncStripeCustomersRequestDto): Promise<SyncStripeCustomersResponseDto> {
		return this.bigQueryService.syncStripeCustomers(dto.holdingId);
	}

	@Post('quantities/ingest')
	@ApiOperation({
		summary: 'Fase 1 — Ingestar cantidades del DWH a la tabla intermedia',
		description:
			'Consulta `datawarehouse-a2e2.finance.sapira_base` para el rango y holding indicados y persiste las filas en ' +
			'`sapira_quantity_imports`. **No toca `public.quantities`**: sirve para revisar qué llegó antes de integrar. ' +
			'Omitir `from`/`to` procesa el mes en curso. El rango es inclusivo en ambos extremos sobre `billing_date`; ' +
			'reingestar un rango solapado es idempotente (las filas sin cambios quedan como `unchanged`).',
	})
	@ApiBody({ type: QuantitiesRangeDto, required: false, examples: QUANTITIES_RANGE_EXAMPLES })
	@ApiResponse({ status: HttpStatus.OK, description: 'Ingesta ejecutada; retorna contadores y el rango efectivo' })
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Falta x-holding-id, el rango es inválido, o el holding no tiene conexión de BigQuery',
	})
	@ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token de autenticación inválido o no proporcionado' })
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async ingestQuantities(@Body() dto: QuantitiesRangeDto, @Headers('x-holding-id') holdingId: string): Promise<QuantitiesIngestResult> {
		return this.bigQueryService.ingestSapiraQuantities(this.requireHoldingId(holdingId), dto);
	}

	@Post('quantities/integrate')
	@ApiOperation({
		summary: 'Fase 2 — Integrar desde la tabla intermedia hacia quantities',
		description:
			'Procesa las filas ya ingestadas de `sapira_quantity_imports` cuyo `period` cae en el rango indicado y las ' +
			'inserta en `public.quantities`. **No consulta BigQuery**, así que no tiene costo de escaneo. Solo integra ' +
			'ítems de contrato variables, valida que la moneda del DWH coincida con la del contrato y nunca sobrescribe ' +
			'overrides existentes: cuando difieren, notifica. Con `retryFailed: true` reprocesa además los estados ' +
			'recuperables (`unmapped`, `blocked`, `not_variable`, `currency_mismatch`), que es el camino tras poblar ' +
			'`contract_items.quote_item_number` o anular una factura bloqueante.',
	})
	@ApiBody({ type: IntegrateQuantitiesDto, required: false, examples: INTEGRATE_QUANTITIES_EXAMPLES })
	@ApiResponse({ status: HttpStatus.OK, description: 'Integración ejecutada; retorna contadores y el rango efectivo' })
	@ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Falta x-holding-id o el rango es inválido' })
	@ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token de autenticación inválido o no proporcionado' })
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async integrateQuantities(@Body() dto: IntegrateQuantitiesDto, @Headers('x-holding-id') holdingId: string): Promise<QuantitiesIntegrationResult> {
		return this.bigQueryService.integrateSapiraQuantities(this.requireHoldingId(holdingId), {
			retryFailed: dto.retryFailed,
			range: { from: dto.from, to: dto.to },
		});
	}

	@Post('quantities/sync')
	@ApiOperation({
		summary: 'Fases 1 + 2 — Integrar cantidades variables de un rango',
		description:
			'Encadena la ingesta y la integración sobre el mismo rango, resuelto una sola vez. Omitir `from`/`to` procesa ' +
			'el mes en curso, que es lo que ejecuta el scheduler diario. Para un backfill conviene usar `ingest` e ' +
			'`integrate` por separado y revisar la auditoría entremedio.',
	})
	@ApiBody({ type: QuantitiesRangeDto, required: false, examples: QUANTITIES_RANGE_EXAMPLES })
	@ApiResponse({ status: HttpStatus.OK, description: 'Sincronización ejecutada; retorna contadores de ambas fases y el rango efectivo' })
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Falta x-holding-id, el rango es inválido, o el holding no tiene conexión de BigQuery',
	})
	@ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token de autenticación inválido o no proporcionado' })
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async syncQuantities(@Body() dto: QuantitiesRangeDto, @Headers('x-holding-id') holdingId: string): Promise<SapiraQuantitiesSyncResult> {
		return this.bigQueryService.syncSapiraQuantities(this.requireHoldingId(holdingId), dto);
	}

	@Get('quantities/imports')
	@ApiOperation({
		summary: 'Auditar el canal automático de cantidades variables',
		description:
			'Lista las filas del DWH ingestadas en `sapira_quantity_imports` con el resultado de su mapeo. ' +
			'Filtrable por `integration_status` para responder "¿por qué esta fila no se integró?", y por `period` ' +
			'puntual o rango `from`/`to` para acotarlo a la misma ventana que se integró.',
	})
	@ApiResponse({ status: HttpStatus.OK, description: 'Listado obtenido exitosamente' })
	@ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Falta x-holding-id o los filtros son inválidos' })
	@ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token de autenticación inválido o no proporcionado' })
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async listQuantityImports(
		@Query() filters: ListQuantityImportsDto,
		@Headers('x-holding-id') holdingId: string
	): Promise<{ total: number; items: SapiraQuantityImport[] }> {
		return this.bigQueryService.listQuantityImports(this.requireHoldingId(holdingId), filters);
	}

	@Post('quantities/:id/replace')
	@ApiOperation({
		summary: 'Reemplazar un override de quantities con los datos del DWH',
		description:
			'Aplica los valores entrantes (provenientes de la notificación de diferencia) sobre el override existente en ' +
			'`quantities`, marca las importaciones asociadas como integradas y resuelve la notificación. No modifica ' +
			'`amount`: ese campo se llena por otro canal.',
	})
	@ApiResponse({ status: HttpStatus.OK, description: 'Override reemplazado exitosamente' })
	@ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Falta x-holding-id' })
	@ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'El override no existe para el holding' })
	@ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token de autenticación inválido o no proporcionado' })
	@ApiHeader(HOLDING_ID_HEADER)
	@HttpCode(HttpStatus.OK)
	async replaceQuantityRecord(
		@Param('id') id: string,
		@Body() dto: ReplaceQuantityRecordDto,
		@Headers('x-holding-id') holdingId: string
	): Promise<QuantityRecord> {
		return this.bigQueryService.replaceQuantityRecord(this.requireHoldingId(holdingId), id, dto);
	}
}

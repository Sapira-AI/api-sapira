import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BancoCentralService } from './banco-central.service';
import { CalculateMonthlyAvgDto, CalculateMonthlyAvgResponseDto } from './dtos/calculate-monthly-avg.dto';
import { ExchangeRateResponseDto, GetExchangeRatesDto, GetLatestExchangeRatesDto, MonthlyAvgResponseDto } from './dtos/get-exchange-rates.dto';
import { GetSeriesDto } from './dtos/get-series.dto';
import { SyncExchangeRatesDto, SyncExchangeRatesResponseDto } from './dtos/sync-exchange-rates.dto';
import { SyncIndicatorsDto } from './dtos/sync-indicators.dto';
import { BancoCentralResponse, IndicadorEconomicoData } from './interfaces/banco-central.interface';
import { ExchangeRatesNotificationService } from './services/exchange-rates-notification.service';
import { ExchangeRatesService } from './services/exchange-rates.service';

@ApiTags('Banco Central')
@Controller('banco-central')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class BancoCentralController {
	constructor(
		private readonly bancoCentralService: BancoCentralService,
		private readonly exchangeRatesService: ExchangeRatesService,
		private readonly notificationService: ExchangeRatesNotificationService
	) {}

	@Get('series')
	@ApiOperation({
		summary: 'Obtener serie de tiempo del Banco Central',
		description:
			'Consulta una serie de tiempo específica del Banco Central de Chile. ' +
			'Permite obtener datos históricos de indicadores económicos como UF, Dólar, Euro, IPC y TPM. ' +
			'Los datos se obtienen directamente de la API del Banco Central en tiempo real.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Serie obtenida exitosamente. Retorna el código de respuesta, descripción y los datos de la serie con sus observaciones.',
		schema: {
			example: {
				Codigo: 0,
				Descripcion: 'Success',
				Series: {
					descripEsp: 'Unidad de fomento (pesos)',
					descripIng: 'Unidad de fomento (Chilean pesos)',
					seriesId: 'F073.UFF.PRE.Z.D',
					Obs: [
						{
							indexDateString: '01-01-2024',
							value: '36280.45',
							statusCode: 'OK',
						},
					],
				},
				SeriesInfos: [],
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Parámetros inválidos o error en la consulta al Banco Central',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'No autenticado. Se requiere Bearer Token',
	})
	@HttpCode(HttpStatus.OK)
	async getSeries(@Query() dto: GetSeriesDto): Promise<BancoCentralResponse> {
		return this.bancoCentralService.getSeries(dto);
	}

	@Post('sync')
	@ApiOperation({
		summary: 'Sincronizar indicadores económicos',
		description:
			'Sincroniza los indicadores económicos principales del Banco Central (UF, Dólar CLP, Dólar COP, Dólar MXN, Dólar BRL, Dólar PEN, Euro, IPC, TPM) ' +
			'y los guarda en la base de datos PostgreSQL. ' +
			'Si no se especifican fechas, sincroniza los últimos 30 días por defecto. ' +
			'Los registros duplicados son ignorados automáticamente gracias a la restricción única (codigo, fecha).',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada exitosamente. Retorna el número de registros sincronizados y errores encontrados.',
		schema: {
			example: {
				synced: 1825,
				errors: 0,
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Fechas inválidas o error en la sincronización',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'No autenticado. Se requiere Bearer Token',
	})
	@HttpCode(HttpStatus.OK)
	async syncIndicators(@Body() dto: SyncIndicatorsDto): Promise<{ synced: number; errors: number }> {
		return this.bancoCentralService.syncIndicators(dto);
	}

	@Get('indicators/latest')
	@ApiOperation({
		summary: 'Obtener últimos valores de indicadores',
		description:
			'Retorna el último valor registrado de cada indicador económico almacenado en la base de datos. ' +
			'Útil para obtener rápidamente los valores actuales de UF, tipos de cambio (CLP, COP, MXN, BRL, PEN), Euro, IPC y TPM ' +
			'sin necesidad de consultar la API del Banco Central. ' +
			'Los datos provienen de la última sincronización realizada.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de indicadores con sus últimos valores registrados',
		schema: {
			example: [
				{
					codigo: 'F073.UFF.PRE.Z.D',
					nombre: 'Unidad de fomento (pesos)',
					fecha: '2024-12-31T00:00:00.000Z',
					valor: 36280.45,
					unidad: null,
				},
				{
					codigo: 'F073.TCO.PRE.Z.D',
					nombre: 'Dólar observado',
					fecha: '2024-12-31T00:00:00.000Z',
					valor: 950.25,
					unidad: null,
				},
			],
		},
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'No autenticado. Se requiere Bearer Token',
	})
	@HttpCode(HttpStatus.OK)
	async getLatestIndicators(): Promise<IndicadorEconomicoData[]> {
		return this.bancoCentralService.getLatestIndicators();
	}

	@Get('indicators/:codigo/history')
	@ApiOperation({
		summary: 'Obtener historial de un indicador',
		description:
			'Retorna el historial completo de valores de un indicador económico específico almacenado en la base de datos. ' +
			'Permite filtrar por rango de fechas. Los resultados se ordenan por fecha descendente (más recientes primero). ' +
			'Códigos disponibles: F073.UFF.PRE.Z.D (UF), F073.TCO.PRE.Z.D (Dólar CLP), F072.COP.USD.N.O.D (Dólar COP), ' +
			'F072.MXN.USD.N.O.D (Dólar MXN), F072.BRL.USD.N.O.D (Dólar BRL), F072.PEN.USD.N.O.D (Dólar PEN), ' +
			'F072.EUR.USD.N.O.D (Euro), F07.IPC.IND.Z.Z.EP18.Z.Z.Z.M (IPC), F022.TPM.TIN.D001.NO.Z.D (TPM).',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Historial del indicador obtenido exitosamente',
		schema: {
			example: [
				{
					codigo: 'F073.UFF.PRE.Z.D',
					nombre: 'Unidad de fomento (pesos)',
					fecha: '2024-01-31T00:00:00.000Z',
					valor: 36150.23,
					unidad: null,
				},
				{
					codigo: 'F073.UFF.PRE.Z.D',
					nombre: 'Unidad de fomento (pesos)',
					fecha: '2024-01-30T00:00:00.000Z',
					valor: 36145.67,
					unidad: null,
				},
			],
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Código de indicador o fechas inválidas',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'No autenticado. Se requiere Bearer Token',
	})
	@HttpCode(HttpStatus.OK)
	async getIndicatorHistory(
		@Param('codigo') codigo: string,
		@Query('fecha_inicio') fechaInicio?: string,
		@Query('fecha_fin') fechaFin?: string
	): Promise<IndicadorEconomicoData[]> {
		return this.bancoCentralService.getIndicatorHistory(codigo, fechaInicio, fechaFin);
	}

	@Post('exchange-rates/sync')
	@ApiOperation({
		summary: 'Sincronizar tipos de cambio del Banco Central',
		description:
			'Sincroniza tipos de cambio desde el Banco Central de Chile para un rango de fechas específico. ' +
			'Incluye conversiones directas (USD/CLP, USD/COP, EUR/USD, etc.) y conversiones indirectas calculadas (CLF→CLP→USD). ' +
			'Los datos se obtienen solo para días hábiles. Calcula automáticamente los promedios mensuales después de la sincronización. ' +
			'Si ya existen datos para una fecha, se actualizan (upsert). ' +
			'Parámetros: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), currencyPairs (opcional, ej: ["USD/CLP", "EUR/USD"])',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async syncExchangeRates(@Body() dto: SyncExchangeRatesDto): Promise<SyncExchangeRatesResponseDto> {
		return this.exchangeRatesService.syncExchangeRates(dto);
	}

	@Post('exchange-rates/sync-historical')
	@ApiOperation({
		summary: 'Sincronización histórica completa desde 2025-01-01',
		description:
			'Sincroniza todos los tipos de cambio disponibles desde el 1 de enero de 2025 hasta la fecha actual. ' +
			'Incluye todos los pares de monedas configurados (USD/CLP, USD/COP, USD/MXN, USD/BRL, USD/PEN, USD/ARS, USD/UYU, EUR/USD, CLF/CLP). ' +
			'Proceso puede tomar varios minutos dependiendo del rango de fechas. ' +
			'Retorna estadísticas: totalProcessed, inserted, updated, errors, indirectConversions.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización histórica completada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async syncHistoricalRates(): Promise<SyncExchangeRatesResponseDto> {
		return this.exchangeRatesService.syncHistoricalRates();
	}

	@Post('exchange-rates/calculate-monthly')
	@ApiOperation({
		summary: 'Calcular promedios mensuales de tipos de cambio',
		description:
			'Calcula estadísticas mensuales de tipos de cambio: promedio (AVG), mínimo (MIN), máximo (MAX) y cantidad de datos (data_points). ' +
			'Solo considera datos de días hábiles (source_type = BANCOCENTRAL), excluyendo fines de semana y festivos. ' +
			'Parámetros opcionales en el body: year (ej: 2025), month (1-12). Si no se especifican, calcula para todos los períodos disponibles. ' +
			'Los resultados se guardan en la tabla exchange_rates_monthly_avg. ' +
			'Ejemplos de body: {} (todos), {"year": 2025} (año completo), {"year": 2025, "month": 1} (mes específico)',
	})
	@ApiBody({
		type: CalculateMonthlyAvgDto,
		required: false,
		examples: {
			'Todos los períodos': {
				value: {},
				description: 'Calcula promedios para todos los años y meses disponibles',
			},
			'Año completo': {
				value: { year: 2025 },
				description: 'Calcula promedios solo para el año 2025',
			},
			'Mes específico': {
				value: { year: 2025, month: 1 },
				description: 'Calcula promedios solo para enero 2025',
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Promedios mensuales calculados exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async calculateMonthlyAverages(@Body() dto: CalculateMonthlyAvgDto): Promise<CalculateMonthlyAvgResponseDto> {
		return this.exchangeRatesService.calculateMonthlyAverages(dto);
	}

	@Get('exchange-rates/latest')
	@ApiOperation({
		summary: 'Obtener los tipos de cambio más recientes',
		description:
			'Retorna el tipo de cambio más reciente disponible para cada par de monedas. ' +
			'Útil para obtener los valores actuales sin especificar fechas. ' +
			'Parámetros opcionales: fromCurrency (ej: USD), toCurrency (ej: CLP) para filtrar por moneda específica. ' +
			'Ejemplo: GET /exchange-rates/latest?fromCurrency=USD&toCurrency=CLP',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Últimos tipos de cambio obtenidos exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getLatestExchangeRates(@Query() dto: GetLatestExchangeRatesDto): Promise<ExchangeRateResponseDto[]> {
		return this.exchangeRatesService.getLatestExchangeRates(dto);
	}

	@Get('exchange-rates/history')
	@ApiOperation({
		summary: 'Consultar historial de tipos de cambio',
		description:
			'Retorna el historial de tipos de cambio con múltiples opciones de filtrado. ' +
			'Parámetros opcionales: fromCurrency, toCurrency, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), limit (default: 100). ' +
			'Los resultados se ordenan por fecha descendente (más recientes primero). ' +
			'Ejemplo: GET /exchange-rates/history?fromCurrency=USD&toCurrency=CLP&startDate=2025-01-01&limit=50',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Historial de tipos de cambio obtenido exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getExchangeRatesHistory(@Query() dto: GetExchangeRatesDto): Promise<ExchangeRateResponseDto[]> {
		return this.exchangeRatesService.getExchangeRates(dto);
	}

	@Get('exchange-rates/monthly-averages')
	@ApiOperation({
		summary: 'Consultar promedios mensuales calculados',
		description:
			'Retorna los promedios mensuales previamente calculados de tipos de cambio. ' +
			'Incluye: avg_rate (promedio), min_rate (mínimo), max_rate (máximo), data_points (cantidad de días hábiles). ' +
			'Parámetros opcionales: year (ej: 2025), month (1-12). ' +
			'Si no se especifican parámetros, retorna todos los promedios disponibles ordenados por año y mes descendente. ' +
			'Ejemplo: GET /exchange-rates/monthly-averages?year=2025&month=1',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Promedios mensuales obtenidos exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getMonthlyAverages(@Query('year') year?: number, @Query('month') month?: number): Promise<MonthlyAvgResponseDto[]> {
		return this.exchangeRatesService.getMonthlyAverages(year, month);
	}

	@Get('exchange-rates/rate')
	@ApiOperation({
		summary: 'Obtener tipo de cambio con fallback automático a día hábil',
		description:
			'Obtiene el tipo de cambio para una fecha específica. Si la fecha solicitada es fin de semana o festivo (sin datos), ' +
			'automáticamente retorna el tipo de cambio del último día hábil anterior. ' +
			'El campo is_fallback indica si se usó el fallback (true) o si es el valor exacto de la fecha (false). ' +
			'Parámetros requeridos: fromCurrency (ej: USD), toCurrency (ej: CLP), date (YYYY-MM-DD). ' +
			'Útil para aplicaciones que necesitan un valor válido sin preocuparse por días no hábiles. ' +
			'Ejemplo: GET /exchange-rates/rate?fromCurrency=USD&toCurrency=CLP&date=2025-01-04 (sábado → retorna viernes 03)',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Tipo de cambio obtenido exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getExchangeRateWithFallback(
		@Query('fromCurrency') fromCurrency: string,
		@Query('toCurrency') toCurrency: string,
		@Query('date') date: string
	) {
		return this.exchangeRatesService.getExchangeRateWithFallback(fromCurrency, toCurrency, date);
	}

	@Post('exchange-rates/test-notification-error')
	@ApiOperation({
		summary: 'Probar email de notificación de error',
		description: 'Envía un email de prueba simulando un error en la sincronización. Útil para verificar la configuración de emails.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Email de prueba enviado exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async testErrorNotification(): Promise<{ message: string }> {
		const testError = new Error('Este es un error de prueba para verificar las notificaciones');
		testError.stack = 'Error: Este es un error de prueba\n    at testErrorNotification (test:1:1)';

		await this.notificationService.sendSyncFailureAlert(testError, 'Prueba manual desde endpoint de testing');

		return {
			message: 'Email de prueba de error enviado exitosamente. Revisa tu bandeja de entrada.',
		};
	}

	@Post('exchange-rates/test-notification-success')
	@ApiOperation({
		summary: 'Probar email de notificación de éxito',
		description: 'Envía un email de prueba simulando una sincronización exitosa. Útil para verificar la configuración de emails.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Email de prueba enviado exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async testSuccessNotification(): Promise<{ message: string }> {
		const mockResult = {
			success: true,
			message: 'Sincronización de prueba completada exitosamente',
			stats: {
				totalProcessed: 150,
				inserted: 120,
				updated: 30,
				errors: 0,
				indirectConversions: 15,
			},
			monthlyAveragesCalculated: {
				periods: 12,
				currencyPairs: 8,
			},
		};

		await this.notificationService.sendSyncSuccessReport(mockResult, 45000);

		return {
			message: 'Email de prueba de éxito enviado exitosamente. Revisa tu bandeja de entrada.',
		};
	}
}

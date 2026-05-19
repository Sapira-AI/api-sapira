import { Body, Controller, Delete, Get, Headers, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SalesforceCredentialsDto } from './dtos/salesforce-credentials.dto';
import { SalesforceQueryDto } from './dtos/salesforce-query.dto';
import {
	SalesforceAuthResponseDto,
	SalesforceConnectionResponseDto,
	SalesforceQueryResponseDto,
	SalesforceSyncAllResponseDto,
	SalesforceSyncResponseDto,
	SalesforceTestConnectionResponseDto,
} from './dtos/salesforce-response.dto';
import { SalesforceSyncDto } from './dtos/salesforce-sync.dto';
import { SalesforceService } from './salesforce.service';

@ApiTags('Salesforce')
@Controller('salesforce')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SalesforceController {
	constructor(private readonly salesforceService: SalesforceService) {}

	@Post('auth')
	@ApiOperation({
		summary: 'Conectar a Salesforce',
		description: 'Autentica y establece una conexión con Salesforce usando OAuth2 password grant',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión establecida exitosamente',
		type: SalesforceAuthResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Credenciales inválidas o error de autenticación',
	})
	async authenticate(
		@Body() credentials: SalesforceCredentialsDto,
		@Headers('x-user-id') userId: string,
		@Headers('x-holding-id') holdingId: string
	): Promise<SalesforceAuthResponseDto> {
		return this.salesforceService.connect(credentials, userId, holdingId);
	}

	@Get('connection')
	@ApiOperation({
		summary: 'Obtener conexión activa',
		description: 'Obtiene la conexión activa de Salesforce para el holding actual',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión encontrada',
		type: SalesforceConnectionResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No hay conexión activa',
	})
	async getConnection(@Headers('x-holding-id') holdingId: string): Promise<SalesforceConnectionResponseDto | null> {
		return this.salesforceService.getConnection(holdingId);
	}

	@Delete('connection')
	@ApiOperation({
		summary: 'Desactivar conexión',
		description: 'Desactiva la conexión activa de Salesforce para el holding actual',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión desactivada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No hay conexión activa para desactivar',
	})
	async disconnect(@Headers('x-holding-id') holdingId: string) {
		return this.salesforceService.disconnect(holdingId);
	}

	@Post('connection/refresh')
	@ApiOperation({
		summary: 'Renovar token de acceso',
		description: 'Renueva manualmente el token de acceso de Salesforce',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Token renovado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No hay conexión activa',
	})
	async refreshToken(@Headers('x-holding-id') holdingId: string) {
		return this.salesforceService.refreshToken(holdingId);
	}

	@Post('query')
	@ApiOperation({
		summary: 'Ejecutar consulta SOQL',
		description: 'Ejecuta una consulta SOQL en Salesforce con auto-refresh de token',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Consulta ejecutada exitosamente',
		type: SalesforceQueryResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error en la consulta SOQL',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No hay conexión activa',
	})
	async executeQuery(@Body() queryDto: SalesforceQueryDto, @Headers('x-holding-id') holdingId: string): Promise<SalesforceQueryResponseDto> {
		return this.salesforceService.executeQuery(queryDto.query, holdingId);
	}

	@Post('sync')
	@ApiOperation({
		summary: 'Sincronizar oportunidades',
		description: 'Sincroniza oportunidades de Salesforce al cache local',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada',
		type: SalesforceSyncResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'No hay conexión activa',
	})
	async syncOpportunities(@Body() syncDto: SalesforceSyncDto, @Headers('x-holding-id') holdingId: string): Promise<SalesforceSyncResponseDto> {
		return this.salesforceService.syncOpportunities(holdingId, syncDto.dateFrom, syncDto.dateTo);
	}

	@Post('sync/all')
	@ApiOperation({
		summary: 'Sincronizar todos los holdings',
		description: 'Sincroniza oportunidades para todos los holdings con conexión activa',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización masiva completada',
		type: SalesforceSyncAllResponseDto,
	})
	async syncAllConnections(): Promise<SalesforceSyncAllResponseDto> {
		return this.salesforceService.syncAllConnections();
	}

	@Post('test')
	@ApiOperation({
		summary: 'Probar conexión SOAP',
		description: 'Prueba la conexión con Salesforce usando SOAP API',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Prueba de conexión exitosa',
		type: SalesforceTestConnectionResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al probar conexión',
	})
	async testConnection(@Headers('x-holding-id') holdingId: string): Promise<SalesforceTestConnectionResponseDto> {
		return this.salesforceService.testConnection(holdingId);
	}

	@Post('preview')
	@ApiOperation({
		summary: 'Preview de sincronización',
		description: 'Genera un preview de la sincronización sin ejecutarla',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Preview generado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	async previewSync(@Body() syncDto: SalesforceSyncDto, @Headers('x-holding-id') holdingId: string) {
		return this.salesforceService.previewSync(holdingId, syncDto.syncType || 'delta');
	}
}

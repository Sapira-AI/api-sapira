import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { Public } from '@/decorators/public.decorator';
import { TokenInterceptor } from '@/interceptors/token.interceptor';

import { SyncInvoicesDTO } from './odoo.dto';
import { OdooService } from './odoo.service';

@ApiTags('Odoo')
@Controller('odoo')
@UseGuards(SupabaseAuthGuard)
@UseInterceptors(TokenInterceptor)
export class OdooController {
	constructor(private readonly odooService: OdooService) {}

	@Post('sync-invoices')
	@ApiOperation({
		summary: 'Sincronizar facturas desde Odoo',
		description: 'Sincroniza facturas y líneas de factura desde Odoo con filtros opcionales de fecha y paginación',
	})
	@ApiBody({
		type: SyncInvoicesDTO,
		required: true,
		description: 'Parámetros para sincronización de facturas',
		examples: {
			'sync-example': {
				summary: 'Ejemplo de sincronización de facturas',
				description: 'Ejemplo completo con todos los parámetros disponibles',
				value: {
					connection_id: '1',
					limit: 60,
					offset: 0,
					date_from: '2025-01-01',
					date_to: '2025-12-10',
					estimate_only: true,
					sync_session_id: '1',
				},
			},
		},
	})
	@ApiOkResponse({ description: 'Sincronización exitosa' })
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	@Public()
	async syncInvoices(@Body() syncData: SyncInvoicesDTO): Promise<any> {
		return await this.odooService.syncInvoices(syncData);
	}

	@Get('companies')
	@ApiOperation({
		summary: 'Obtener compañías desde Odoo',
		description: 'Obtiene todas las compañías disponibles en Odoo junto con las compañías existentes en Sapira para mapeo',
	})
	@ApiQuery({
		name: 'connection_id',
		required: true,
		type: String,
		description: 'ID de la conexión de Odoo',
		example: '1',
	})
	@ApiOkResponse({ description: 'Compañías obtenidas exitosamente' })
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	@Public()
	async getCompanies(@Query('connection_id') connectionId: string): Promise<any> {
		return await this.odooService.getCompanies({ connection_id: connectionId });
	}

	@Get('products')
	@ApiOperation({
		summary: 'Obtener productos desde Odoo',
		description: 'Obtiene todos los productos disponibles en Odoo junto con los productos existentes en Sapira para mapeo de tax IDs',
	})
	@ApiQuery({
		name: 'connection_id',
		required: true,
		type: String,
		description: 'ID de la conexión de Odoo',
		example: '1',
	})
	@ApiOkResponse({ description: 'Productos obtenidos exitosamente' })
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	@Public()
	async getProducts(@Query('connection_id') connectionId: string): Promise<any> {
		return await this.odooService.getProducts({ connection_id: connectionId });
	}
}

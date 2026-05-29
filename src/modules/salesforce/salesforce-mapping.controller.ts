import { Body, Controller, Delete, Get, Headers, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	CreateObjectMappingDto,
	CreateProductMappingDto,
	CreateQuoteTypeMappingDto,
	SalesforceObjectMappingDto,
	SalesforceProductMappingDto,
	SalesforceQuoteTypeMappingDto,
	UpdateObjectMappingDto,
	UpdateProductMappingDto,
	UpdateQuoteTypeMappingDto,
} from './dtos/salesforce-mapping.dto';
import { SalesforceMappingService } from './services/salesforce-mapping.service';

@ApiTags('Salesforce Mappings')
@Controller('salesforce/mappings')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SalesforceMappingController {
	constructor(private readonly mappingService: SalesforceMappingService) {}

	@Get('products')
	@ApiOperation({
		summary: 'Obtener mapeos de productos',
		description: 'Obtiene todos los mapeos de productos Salesforce → Sapira para el holding',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de mapeos de productos',
		type: [SalesforceProductMappingDto],
	})
	async getProductMappings(@Headers('x-holding-id') holdingId: string) {
		return this.mappingService.getProductMappings(holdingId);
	}

	@Post('products')
	@ApiOperation({
		summary: 'Crear mapeo de producto',
		description: 'Crea un nuevo mapeo de producto Salesforce → Sapira',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Mapeo creado exitosamente',
		type: SalesforceProductMappingDto,
	})
	async createProductMapping(@Headers('x-holding-id') holdingId: string, @Body() dto: CreateProductMappingDto) {
		return this.mappingService.createProductMapping(holdingId, dto);
	}

	@Put('products/:id')
	@ApiOperation({
		summary: 'Actualizar mapeo de producto',
		description: 'Actualiza un mapeo de producto existente',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo actualizado exitosamente',
		type: SalesforceProductMappingDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async updateProductMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string, @Body() dto: UpdateProductMappingDto) {
		return this.mappingService.updateProductMapping(id, holdingId, dto);
	}

	@Delete('products/:id')
	@ApiOperation({
		summary: 'Eliminar mapeo de producto',
		description: 'Elimina un mapeo de producto',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo eliminado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async deleteProductMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string) {
		await this.mappingService.deleteProductMapping(id, holdingId);
		return { success: true, message: 'Product mapping deleted successfully' };
	}

	@Get('quote-types')
	@ApiOperation({
		summary: 'Obtener mapeos de tipos de cotización',
		description: 'Obtiene todos los mapeos de tipos de oportunidad Salesforce → quote_type Sapira',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de mapeos de tipos',
		type: [SalesforceQuoteTypeMappingDto],
	})
	async getQuoteTypeMappings(@Headers('x-holding-id') holdingId: string) {
		return this.mappingService.getQuoteTypeMappings(holdingId);
	}

	@Post('quote-types')
	@ApiOperation({
		summary: 'Crear mapeo de tipo de cotización',
		description: 'Crea un nuevo mapeo de tipo de oportunidad Salesforce → quote_type Sapira',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Mapeo creado exitosamente',
		type: SalesforceQuoteTypeMappingDto,
	})
	async createQuoteTypeMapping(@Headers('x-holding-id') holdingId: string, @Body() dto: CreateQuoteTypeMappingDto) {
		return this.mappingService.createQuoteTypeMapping(holdingId, dto);
	}

	@Put('quote-types/:id')
	@ApiOperation({
		summary: 'Actualizar mapeo de tipo de cotización',
		description: 'Actualiza un mapeo de tipo existente',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo actualizado exitosamente',
		type: SalesforceQuoteTypeMappingDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async updateQuoteTypeMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string, @Body() dto: UpdateQuoteTypeMappingDto) {
		return this.mappingService.updateQuoteTypeMapping(id, holdingId, dto);
	}

	@Delete('quote-types/:id')
	@ApiOperation({
		summary: 'Eliminar mapeo de tipo de cotización',
		description: 'Elimina un mapeo de tipo',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo eliminado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async deleteQuoteTypeMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string) {
		await this.mappingService.deleteQuoteTypeMapping(id, holdingId);
		return { success: true, message: 'Quote type mapping deleted successfully' };
	}

	@Get('objects')
	@ApiOperation({
		summary: 'Obtener mapeos de objetos',
		description: 'Obtiene todos los mapeos de objetos Salesforce → registros Sapira (Accounts → clients, etc.)',
	})
	@ApiQuery({ name: 'type', required: false, description: 'Filtrar por tipo de objeto (Account, Contact, etc.)' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de mapeos de objetos',
		type: [SalesforceObjectMappingDto],
	})
	async getObjectMappings(@Headers('x-holding-id') holdingId: string, @Query('type') objectType?: string) {
		return this.mappingService.getObjectMappings(holdingId, objectType);
	}

	@Post('objects')
	@ApiOperation({
		summary: 'Crear mapeo de objeto',
		description: 'Crea un nuevo mapeo de objeto Salesforce → registro Sapira',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Mapeo creado exitosamente',
		type: SalesforceObjectMappingDto,
	})
	async createObjectMapping(@Headers('x-holding-id') holdingId: string, @Body() dto: CreateObjectMappingDto) {
		return this.mappingService.createObjectMapping(holdingId, dto);
	}

	@Put('objects/:id')
	@ApiOperation({
		summary: 'Actualizar mapeo de objeto',
		description: 'Actualiza un mapeo de objeto existente',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo actualizado exitosamente',
		type: SalesforceObjectMappingDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async updateObjectMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string, @Body() dto: UpdateObjectMappingDto) {
		return this.mappingService.updateObjectMapping(id, holdingId, dto);
	}

	@Delete('objects/:id')
	@ApiOperation({
		summary: 'Eliminar mapeo de objeto',
		description: 'Elimina un mapeo de objeto',
	})
	@ApiParam({ name: 'id', description: 'ID del mapeo' })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mapeo eliminado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Mapeo no encontrado',
	})
	async deleteObjectMapping(@Param('id') id: string, @Headers('x-holding-id') holdingId: string) {
		await this.mappingService.deleteObjectMapping(id, holdingId);
		return { success: true, message: 'Object mapping deleted successfully' };
	}
}

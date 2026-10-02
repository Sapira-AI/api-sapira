import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { CreateProductDto, ProductsQueryDto, UpdateProductDto } from './dtos/products.dto';
import { ProductsService } from './products.service';

/** Productos (pestaña de Precios, contrato §6). Leer = VIEW_CONTRATOS; escribir = EDIT_CONTRATOS (Precios = Contratos, D2). */
@ApiTags('Productos')
@Controller('products')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(PERMISSION_CODES.viewContracts)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class ProductsController {
	constructor(private readonly products: ProductsService) {}

	@Get()
	@ApiOperation({ summary: 'Productos con uso y mapeos (sin precio)' })
	list(@HoldingId() holdingId: string, @Query() query: ProductsQueryDto) {
		return this.products.list(holdingId, query);
	}

	@Get(':id')
	get(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.products.get(holdingId, id);
	}

	@Post()
	@RequirePermission(PERMISSION_CODES.editContracts)
	create(@HoldingId() holdingId: string, @Body() body: CreateProductDto) {
		return this.products.create(holdingId, body);
	}

	@Patch(':id')
	@RequirePermission(PERMISSION_CODES.editContracts)
	update(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProductDto) {
		return this.products.update(holdingId, id, body);
	}

	@Post(':id/archive')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editContracts)
	archive(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.products.setStatus(holdingId, id, 'archived');
	}

	@Post(':id/reactivate')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editContracts)
	reactivate(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.products.setStatus(holdingId, id, 'active');
	}

	@Delete(':id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editContracts)
	async remove(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.products.remove(holdingId, id);
	}
}

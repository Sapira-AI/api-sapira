import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ClientDirectoryService } from './client-directory.service';
import { BulkUpdateContactsDto, QueryClientContactsDto, UpsertClientContactDto } from './dtos/client-directory.dto';

/** Contactos de clientes (`client_contacts`) del holding. */
@ApiTags('Client contacts')
@Controller('client-contacts')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ClientContactsController {
	constructor(private readonly directory: ClientDirectoryService) {}

	@Get()
	@ApiOperation({ summary: 'Contactos del holding', description: 'Paginados; filtro por cliente comercial y tipo de contacto' })
	async list(@Query() query: QueryClientContactsDto, @HoldingId() holdingId: string) {
		return await this.directory.listContacts(holdingId, {
			page: query.page,
			limit: query.limit,
			search: query.search,
			clientId: query.client_id,
			contactType: query.contact_type,
			sortBy: query.sort_by,
			sortOrder: query.sort_order,
		});
	}

	@Get('stats')
	@ApiOperation({ summary: 'Totales de contactos por tipo' })
	async stats(@HoldingId() holdingId: string) {
		return await this.directory.contactStats(holdingId);
	}

	@Post()
	@ApiOperation({ summary: 'Crear contacto', description: 'Valida que el cliente (si viene) sea del holding' })
	async create(@Body() body: UpsertClientContactDto, @HoldingId() holdingId: string) {
		return await this.directory.createContact(holdingId, body);
	}

	@Post('bulk-update')
	@ApiOperation({ summary: 'Reasignar cliente y/o cambiar rol de varios contactos' })
	async bulkUpdate(@Body() body: BulkUpdateContactsDto, @HoldingId() holdingId: string) {
		return await this.directory.bulkUpdateContacts(holdingId, body.contact_ids, {
			client_id: body.client_id,
			contact_type: body.contact_type,
		});
	}

	@Patch(':id')
	@ApiOperation({ summary: 'Editar contacto' })
	@ApiParam({ name: 'id', type: String })
	async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpsertClientContactDto, @HoldingId() holdingId: string) {
		return await this.directory.updateContact(holdingId, id, body);
	}
}

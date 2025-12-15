import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class InvoiceDTO {
	@IsString()
	@ApiProperty({ required: true })
	'name': string;
}

export class SyncInvoicesDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;

	@IsOptional()
	@IsNumber()
	@Type(() => Number)
	@ApiProperty({ required: false, default: 60, description: 'Límite de registros por lote' })
	limit?: number = 60;

	@IsOptional()
	@IsNumber()
	@Type(() => Number)
	@ApiProperty({ required: false, default: 0, description: 'Offset para paginación' })
	offset?: number = 0;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha desde (YYYY-MM-DD)' })
	date_from?: string;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha hasta (YYYY-MM-DD)' })
	date_to?: string;

	@IsOptional()
	@IsBoolean()
	@Type(() => Boolean)
	@ApiProperty({ required: false, default: false, description: 'Solo estimar cantidad de registros' })
	estimate_only?: boolean = false;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'ID de sesión de sincronización' })
	sync_session_id?: string;
}

export class SyncPartnersDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;

	@IsOptional()
	@IsNumber()
	@Type(() => Number)
	@ApiProperty({ required: false, default: 100, description: 'Límite de registros por lote' })
	limit?: number = 100;

	@IsOptional()
	@IsNumber()
	@Type(() => Number)
	@ApiProperty({ required: false, default: 0, description: 'Offset para paginación' })
	offset?: number = 0;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha desde para filtrar partners (YYYY-MM-DD)' })
	date_from?: string;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha hasta para filtrar partners (YYYY-MM-DD)' })
	date_to?: string;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'ID de sesión de sincronización' })
	sync_session_id?: string;
}

export class GetCompaniesDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;
}

export class GetProductsDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;
}

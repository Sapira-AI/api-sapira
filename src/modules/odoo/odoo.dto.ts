import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';

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

export class GetProductsDTO {
	@ApiProperty({ description: 'ID de la conexión de Odoo' })
	@IsString()
	connection_id!: string;
}

export class StartAsyncJobDTO {
	@ApiProperty({ description: 'ID de la conexión de Odoo' })
	@IsString()
	connection_id!: string;

	@ApiProperty({ description: 'ID de la empresa (holding)' })
	@IsString()
	holding_id!: string;

	@ApiProperty({ description: 'Fecha de inicio para sincronización', required: false, example: '2025-01-01' })
	@IsOptional()
	@IsString()
	start_date?: string;

	@ApiProperty({ description: 'Fecha de fin para sincronización', required: false })
	@IsOptional()
	@IsString()
	end_date?: string;
}

export class JobStatusResponseDTO {
	@ApiProperty({ description: 'ID del job' })
	job_id!: string;

	@ApiProperty({ description: 'Estado del job', enum: ['running', 'completed', 'failed', 'cancelled'] })
	status!: string;

	@ApiProperty({ description: 'Registros procesados' })
	records_processed!: number;

	@ApiProperty({ description: 'Registros exitosos' })
	records_success!: number;

	@ApiProperty({ description: 'Registros fallidos' })
	records_failed!: number;

	@ApiProperty({ description: 'Porcentaje de progreso' })
	progress_percentage!: number;

	@ApiProperty({ description: 'Tiempo de ejecución en milisegundos', required: false })
	execution_time_ms?: number;

	@ApiProperty({ description: 'Fecha de inicio' })
	started_at!: Date;

	@ApiProperty({ description: 'Fecha de finalización', required: false })
	completed_at?: Date;

	@ApiProperty({ description: 'Detalles de errores', required: false })
	error_details?: any;
}

export class CountRecordsDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha desde (YYYY-MM-DD)' })
	date_from?: string;

	@IsOptional()
	@IsString()
	@ApiProperty({ required: false, description: 'Fecha hasta (YYYY-MM-DD)' })
	date_to?: string;
}

export class CountRecordsResponseDTO {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success!: boolean;

	@ApiProperty({ description: 'Total de líneas de factura encontradas' })
	total_lines!: number;

	@ApiProperty({ description: 'Total de facturas encontradas' })
	total_invoices!: number;

	@ApiProperty({ description: 'Total de partners únicos en las facturas' })
	total_partners!: number;

	@ApiProperty({ description: 'Total de facturas sin líneas de producto' })
	total_invoices_without_product_lines!: number;

	@ApiProperty({ description: 'Nombres de facturas sin líneas de producto', type: [String] })
	invoices_without_product_lines_names!: string[];

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message!: string;
}

export class GetCompaniesDTO {
	@IsString()
	@ApiProperty({ required: true, description: 'ID de la conexión de Odoo' })
	connection_id: string;

	@IsString()
	@ApiProperty({ required: true, description: 'ID del holding' })
	holding_id: string;
}

export class OdooCompanyDTO {
	@ApiProperty({ description: 'ID de la compañía en Odoo' })
	id!: number;

	@ApiProperty({ description: 'Nombre de la compañía' })
	name!: string;

	@ApiProperty({ description: 'Nombre para mostrar' })
	display_name!: string;

	@ApiProperty({ description: 'Número de VAT/RUC' })
	vat!: string;

	@ApiProperty({ description: 'País de la compañía', nullable: true })
	country!: string | null;

	@ApiProperty({ description: 'Moneda de la compañía', nullable: true })
	currency!: string | null;

	@ApiProperty({ description: 'Email de la compañía' })
	email!: string;

	@ApiProperty({ description: 'Teléfono de la compañía' })
	phone!: string;

	@ApiProperty({ description: 'Sitio web de la compañía' })
	website!: string;

	@ApiProperty({ description: 'Dirección completa' })
	address!: string;

	@ApiProperty({ description: 'Estado/Provincia', nullable: true })
	state!: string | null;

	@ApiProperty({ description: 'ID del partner asociado', type: [Number] })
	partner_id!: [number, string];

	@ApiProperty({ description: 'ID del impuesto de venta por defecto', nullable: true })
	default_sale_tax_id!: number | false;

	@ApiProperty({ description: 'Nombre del impuesto de venta por defecto', nullable: true })
	default_sale_tax_name!: string | null;

	@ApiProperty({ description: 'ID del impuesto de compra por defecto', nullable: true })
	default_purchase_tax_id!: number | false;

	@ApiProperty({ description: 'Nombre del impuesto de compra por defecto', nullable: true })
	default_purchase_tax_name!: string | null;

	@ApiProperty({ description: 'Porcentaje del impuesto de venta por defecto', nullable: true })
	default_sale_tax_percentage!: number | null;

	@ApiProperty({ description: 'Tipo del impuesto de venta (percent, fixed, group, division)', nullable: true })
	default_sale_tax_type!: string | null;

	@ApiProperty({ description: 'Porcentaje del impuesto de compra por defecto', nullable: true })
	default_purchase_tax_percentage!: number | null;

	@ApiProperty({ description: 'Tipo del impuesto de compra (percent, fixed, group, division)', nullable: true })
	default_purchase_tax_type!: string | null;

	@ApiProperty({ description: 'ID del país fiscal', nullable: true })
	fiscal_country_id!: number | false;

	@ApiProperty({ description: 'Nombre del país fiscal', nullable: true })
	fiscal_country_name!: string | null;

	@ApiProperty({ description: 'Método de redondeo de impuestos', enum: ['round_per_line', 'round_globally'] })
	tax_calculation_rounding!: 'round_per_line' | 'round_globally';

	@ApiProperty({ description: 'Usar base de efectivo para impuestos' })
	use_cash_basis!: boolean;
}

export class SapiraCompanyDTO {
	@ApiProperty({ description: 'ID de la compañía en Sapira' })
	id!: string;

	@ApiProperty({ description: 'Nombre del holding' })
	holding_name!: string;

	@ApiProperty({ description: 'Nombre legal de la compañía' })
	legal_name!: string;

	@ApiProperty({ description: 'ID de integración con Odoo', nullable: true })
	odoo_integration_id!: number | null;

	@ApiProperty({ description: 'ID del holding' })
	holding_id!: string;
}

export class ConnectionInfoDTO {
	@ApiProperty({ description: 'ID de la conexión' })
	id!: string;

	@ApiProperty({ description: 'URL del servidor Odoo' })
	server_url!: string;

	@ApiProperty({ description: 'Nombre de la base de datos' })
	database_name!: string;

	@ApiProperty({ description: 'ID del holding' })
	holding_id!: string;
}

export class GetCompaniesResponseDTO {
	@ApiProperty({ description: 'Indica si la operación fue exitosa' })
	success!: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message!: string;

	@ApiProperty({ description: 'Compañías obtenidas de Odoo', type: [OdooCompanyDTO] })
	odoo_companies!: OdooCompanyDTO[];

	@ApiProperty({ description: 'Compañías existentes en Sapira', type: [SapiraCompanyDTO] })
	sapira_companies!: SapiraCompanyDTO[];

	@ApiProperty({ description: 'Información de la conexión', type: ConnectionInfoDTO })
	connection_info!: ConnectionInfoDTO;
}

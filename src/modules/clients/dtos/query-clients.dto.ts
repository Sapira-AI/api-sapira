import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

import { CLIENT_LIFECYCLE_STATUSES, type ClientLifecycleStatus } from '../client-lifecycle';

/** Columnas por las que se puede ordenar `GET /clients` (lista blanca: nunca se interpola el input). */
export const CLIENT_SORT_FIELDS = [
	'name_commercial',
	'client_number',
	'segment',
	'industry',
	'market',
	'country',
	'status',
	'client_since',
	'created_at',
] as const;
export type ClientSortField = (typeof CLIENT_SORT_FIELDS)[number];

export class QueryClientsDto {
	@ApiPropertyOptional({ description: 'Columna de orden', enum: CLIENT_SORT_FIELDS, default: 'created_at' })
	@IsIn(CLIENT_SORT_FIELDS)
	@IsOptional()
	sort_by?: ClientSortField;

	@ApiPropertyOptional({ description: 'Dirección del orden', enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sort_order?: 'asc' | 'desc';

	/**
	 * Solo compatibilidad con el front viejo: el buscador de clientes comerciales de Integraciones › Salesforce
	 * (`SalesforceClientSearchSelect`) lo manda junto al header. No se usa:
	 * el holding sale de `HoldingScopeGuard`, que rechaza (403) un valor distinto al de `x-holding-id`. Se quita cuando esa pantalla se migre.
	 */
	@ApiPropertyOptional({ deprecated: true, description: 'Compatibilidad: debe coincidir con x-holding-id; se ignora' })
	@IsUUID()
	@IsOptional()
	holding_id?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por segmento',
		example: 'Enterprise',
	})
	@IsString()
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por industria',
		example: 'Tecnología',
	})
	@IsString()
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por mercado',
		example: 'Latam',
	})
	@IsString()
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por estado',
		example: 'Activo',
	})
	@IsString()
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por estado calculado desde contratos y suscripciones (ver client-lifecycle.ts)',
		enum: CLIENT_LIFECYCLE_STATUSES,
	})
	@IsIn(CLIENT_LIFECYCLE_STATUSES)
	@IsOptional()
	lifecycle?: ClientLifecycleStatus;

	@ApiPropertyOptional({
		description: 'Filtrar por país',
		example: 'Chile',
	})
	@IsString()
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({
		description: 'Buscar por nombre comercial (búsqueda parcial)',
		example: 'Acme',
	})
	@IsString()
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({
		description: 'Número de página',
		example: 1,
		default: 1,
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({
		description: 'Cantidad de resultados por página',
		example: 20,
		default: 20,
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	limit?: number;
}

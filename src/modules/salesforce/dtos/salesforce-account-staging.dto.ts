import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class SalesforceAccountImportDto {
	@ApiPropertyOptional({
		description: 'Letra inicial para filtrar Accounts',
		example: 'A',
	})
	@IsOptional()
	@IsString()
	letter?: string;

	@ApiPropertyOptional({
		description: 'Sub-rango alfabético para filtrar Accounts',
		example: 'Aa-Ag',
	})
	@IsOptional()
	@IsString()
	subRange?: string;

	@ApiPropertyOptional({
		description: 'Fecha desde para traer Accounts con oportunidades en ese rango',
		example: '2024-01-01',
	})
	@IsOptional()
	@IsDateString()
	dateFrom?: string;

	@ApiPropertyOptional({
		description: 'Fecha hasta para traer Accounts con oportunidades en ese rango',
		example: '2024-01-31',
	})
	@IsOptional()
	@IsDateString()
	dateTo?: string;
}

export class SalesforceAccountProcessDto {
	@ApiPropertyOptional({
		description: 'IDs de Salesforce Account a procesar',
		type: [String],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	salesforceIds?: string[];

	@ApiPropertyOptional({
		description: 'Campos del cliente comercial a actualizar cuando se trata de clientes ya mapeados',
		type: [String],
		example: ['country', 'industry', 'segment', 'name_commercial'],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	@IsIn(['country', 'industry', 'segment', 'name_commercial'], { each: true })
	clientFields?: string[];
}

export class SalesforceOpportunityImportDto {
	@ApiPropertyOptional({
		description: 'Fecha desde (YYYY-MM-DD)',
		example: '2024-01-01',
	})
	@IsOptional()
	@IsDateString()
	dateFrom?: string;

	@ApiPropertyOptional({
		description: 'Fecha hasta (YYYY-MM-DD)',
		example: '2024-01-31',
	})
	@IsOptional()
	@IsDateString()
	dateTo?: string;

	@ApiPropertyOptional({
		description: 'IDs específicos de oportunidades Salesforce a importar a staging',
		type: [String],
		example: ['006RO00000czj8nYAA', '006RO00000d3MLkYAM'],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	opportunityIds?: string[];
}

export class SalesforceOpportunityPreviewDto extends SalesforceOpportunityImportDto {
	@ApiPropertyOptional({
		description: 'Etapas de Salesforce a incluir en la revisión',
		type: [String],
		example: ['Ganado', 'Negotiation/Review'],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	stages?: string[];
}

export class SalesforceOpportunityProcessDto {
	@ApiPropertyOptional({
		description: 'IDs específicos de oportunidades Salesforce a procesar desde staging',
		type: [String],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	opportunityIds?: string[];
}

export class SalesforceSyncRunStartDto extends SalesforceOpportunityImportDto {
	@ApiPropertyOptional({
		description: 'IDs de oportunidades que formarán la ejecución asíncrona',
		type: [String],
	})
	@IsArray()
	@ArrayNotEmpty()
	@IsString({ each: true })
	declare opportunityIds: string[];
}

export class SalesforceOpportunityRetryDto {
	@ApiPropertyOptional({
		description: 'Paso que se reintentará según la causa registrada en la notificación',
		enum: ['update_staging', 'process_final', 'retry_full'],
		default: 'retry_full',
	})
	@IsOptional()
	@IsIn(['update_staging', 'process_final', 'retry_full'])
	mode?: 'update_staging' | 'process_final' | 'retry_full';
}

export class SalesforceAccountMappingViewDto {
	@ApiPropertyOptional({
		description: 'Texto de búsqueda sobre campos relevantes de la cuenta',
		example: 'Acme',
	})
	@IsOptional()
	@IsString()
	search?: string;

	@ApiPropertyOptional({
		description: 'Estado de procesamiento en staging',
		example: 'create',
	})
	@IsOptional()
	@IsString()
	status?: string;

	@ApiPropertyOptional({
		description: 'País mostrado en UI',
		example: 'Chile',
	})
	@IsOptional()
	@IsString()
	country?: string;

	@ApiPropertyOptional({
		description: 'Código ISO del país cuando el origen viene como código',
		example: 'CL',
	})
	@IsOptional()
	@IsString()
	countryCode?: string;

	@ApiPropertyOptional({
		description: 'Estado del vínculo de mapeo en la grilla',
		example: 'mapped',
		enum: ['all', 'mapped', 'unmapped', 'outdated'],
	})
	@IsOptional()
	@IsString()
	@IsIn(['all', 'mapped', 'unmapped', 'outdated'])
	mappingState?: 'all' | 'mapped' | 'unmapped' | 'outdated';

	@ApiPropertyOptional({
		description: 'Número de página',
		example: 1,
		default: 1,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({
		description: 'Cantidad de resultados por página',
		example: 50,
		default: 50,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number;
}

export class SalesforceStagingListDto {
	@ApiPropertyOptional({
		description: 'Texto de búsqueda por nombre o identificador Salesforce',
	})
	@IsOptional()
	@IsString()
	search?: string;

	@ApiPropertyOptional({
		description: 'Estado único de procesamiento en staging',
		enum: ['create', 'update', 'processed', 'error'],
	})
	@IsOptional()
	@IsIn(['create', 'update', 'processed', 'error'])
	status?: string;

	@ApiPropertyOptional({
		description: 'Estados de procesamiento separados por coma',
		example: 'create,update',
	})
	@IsOptional()
	@IsString()
	@Matches(/^(create|update|processed|error)(,(create|update|processed|error))*$/)
	statuses?: string;

	@ApiPropertyOptional({ description: 'Número de página', default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({ description: 'Cantidad de resultados por página', default: 50, maximum: 100 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SchedulerReportQueryDto {
	@ApiPropertyOptional({ example: '2026-08-01', description: 'Fecha inicial inclusiva (YYYY-MM-DD)' })
	@IsOptional()
	@IsISO8601()
	from?: string;

	@ApiPropertyOptional({ example: '2026-08-31', description: 'Fecha final inclusiva (YYYY-MM-DD)' })
	@IsOptional()
	@IsISO8601()
	to?: string;

	@ApiPropertyOptional({ enum: ['production', 'qa', 'unknown'] })
	@IsOptional()
	@IsIn(['production', 'qa', 'unknown'])
	environment?: 'production' | 'qa' | 'unknown';

	@ApiPropertyOptional({ enum: ['automatic', 'manual'] })
	@IsOptional()
	@IsIn(['automatic', 'manual'])
	source?: 'automatic' | 'manual';

	@ApiPropertyOptional({ description: 'Filtra simulaciones o ejecuciones reales', example: false })
	@IsOptional()
	@IsBooleanString()
	dryRun?: string;

	@ApiPropertyOptional({ description: 'Holding específico' })
	@IsOptional()
	@IsString()
	holdingId?: string;

	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page = 1;

	@ApiPropertyOptional({ default: 25, maximum: 100 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit = 25;
}

export class SchedulerDistinctErrorDto {
	@ApiProperty()
	message: string;

	@ApiProperty()
	count: number;
}

export class SchedulerErrorInvoiceDto {
	@ApiProperty()
	invoiceId: string;

	@ApiProperty()
	holdingId: string;

	@ApiPropertyOptional()
	holdingName?: string;

	@ApiProperty()
	invoiceNumber: string;

	@ApiPropertyOptional()
	clientName?: string;

	@ApiPropertyOptional()
	companyName?: string;

	@ApiPropertyOptional()
	issueDate?: Date;

	@ApiPropertyOptional()
	odooInvoiceId?: number;

	@ApiPropertyOptional()
	error?: string;

	@ApiPropertyOptional()
	details?: string;
}

export class SchedulerInvoiceResultDto extends SchedulerErrorInvoiceDto {
	@ApiProperty({ enum: ['sent', 'error', 'skipped'] })
	status: 'sent' | 'error' | 'skipped';
}

export class SchedulerReportItemDto {
	@ApiProperty()
	jobId: string;

	@ApiProperty()
	holdingId: string;

	@ApiPropertyOptional()
	holdingName?: string;

	@ApiProperty({ enum: ['production', 'qa', 'unknown'] })
	executionEnvironment: 'production' | 'qa' | 'unknown';

	@ApiProperty({ enum: ['automatic', 'manual'] })
	executionSource: 'automatic' | 'manual';

	@ApiProperty()
	dryRun: boolean;

	@ApiProperty()
	status: string;

	@ApiProperty()
	startedAt: Date;

	@ApiPropertyOptional()
	completedAt?: Date;

	@ApiProperty()
	durationMs: number | null;

	@ApiProperty()
	progress: { total: number; sent: number; errors: number; skipped: number; current: number };

	@ApiProperty({ type: [SchedulerDistinctErrorDto] })
	distinctErrors: SchedulerDistinctErrorDto[];

	@ApiProperty({ type: [SchedulerErrorInvoiceDto] })
	errorInvoices: SchedulerErrorInvoiceDto[];

	@ApiProperty({ type: [SchedulerInvoiceResultDto] })
	invoiceResults: SchedulerInvoiceResultDto[];

	@ApiPropertyOptional()
	error?: string;
}

export class SchedulerReportResponseDto {
	@ApiProperty({ type: [SchedulerReportItemDto] })
	items: SchedulerReportItemDto[];

	@ApiProperty()
	total: number;

	@ApiProperty()
	page: number;

	@ApiProperty()
	limit: number;

	@ApiProperty()
	summary: { executions: number; total: number; sent: number; errors: number; skipped: number };
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

/** Estados de suscripción de Stripe (`subscriptions.status`). En prod hoy: active, canceled, past_due. */
export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'canceled', 'unpaid', 'trialing', 'paused', 'incomplete', 'incomplete_expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
const STATUS_VALUES = ['all', ...SUBSCRIPTION_STATUSES];
const STATUS_LIST = new RegExp(`^(${STATUS_VALUES.join('|')})(,(${STATUS_VALUES.join('|')})){0,9}$`);

export const SUBSCRIPTION_SORT_FIELDS = [
	'client_name',
	'status',
	'start_date',
	'current_period_end',
	'mrr',
	'monthly_amount',
	'created_at',
	'legal_name',
	'products',
	'monthly_amount_system_currency',
	'cancel_at_period_end',
	'stripe_subscription_id',
	'last_synced_at',
] as const;
export type SubscriptionSortField = (typeof SUBSCRIPTION_SORT_FIELDS)[number];

/** Query de `GET /contracts/subscriptions`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryContractSubscriptionsDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25, maximum: 200 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200)
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({ description: `Estado de la suscripción; varios separados por coma (${STATUS_VALUES.join(', ')})`, default: 'all' })
	@Matches(STATUS_LIST, { message: `status debe ser uno o varios de: ${STATUS_VALUES.join(', ')}` })
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({ description: 'Busca por cliente comercial, razón social o id de Stripe' })
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ description: 'Cliente comercial' })
	@IsUUID()
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Razón social (pestaña Suscripciones del Razón social 360)' })
	@IsUUID()
	@IsOptional()
	entityId?: string;

	@ApiPropertyOptional({ enum: SUBSCRIPTION_SORT_FIELDS, default: 'start_date' })
	@IsIn(SUBSCRIPTION_SORT_FIELDS)
	@IsOptional()
	sortBy?: SubscriptionSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

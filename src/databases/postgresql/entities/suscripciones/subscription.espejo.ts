import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { StripeConnection } from '@/modules/stripe/entities/stripe-connection.entity';

/**
 * Espejo de `public.subscriptions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 434 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Suscripciones externas (Stripe, Chargebee, etc.) que no siguen el modelo de contratos a plazo fijo. Read-only desde Sapira.
 * Referenciada por FK desde 3 tabla(s): invoices, revenue_schedule_monthly, subscription_items.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_subscriptions_updated_at · BEFORE UPDATE FOR EACH ROW → update_stripe_updated_at_column().
 * Policies (4): Users can delete their holding's subscriptions (DELETE, public); Users can insert subscriptions for their holdings (INSERT, public); Users can update their holding's subscriptions (UPDATE, public); Users can view their holding's subscriptions (SELECT, public).
 */
@Entity('subscriptions')
@Unique('uq_subscriptions_holding_external', ['holding_id', 'external_id'])
@Check(
	'subscriptions_status_check',
	"status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'paused'::text, 'unpaid'::text, 'trialing'::text, 'incomplete'::text, 'incomplete_expired'::text])"
)
@Index('idx_subscriptions_client_entity_id', ['client_entity_id'])
@Index('idx_subscriptions_client_id', ['client_id'])
@Index('idx_subscriptions_company_id', ['company_id'])
@Index('idx_subscriptions_connection_id', ['connection_id'])
@Index('idx_subscriptions_external_id', ['external_id'])
@Index('idx_subscriptions_holding_id', ['holding_id'])
@Index('idx_subscriptions_source', ['source'])
@Index('idx_subscriptions_status', ['status'])
export class Subscription {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'subscriptions_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'uuid', nullable: false })
	client_id: string;

	@Column({ type: 'uuid', nullable: false })
	client_entity_id: string;

	@Column({ type: 'text', nullable: true })
	client_name_commercial?: string;

	@Column({ type: 'text', nullable: true })
	legal_client_name?: string;

	/** ID de la suscripción en el sistema externo (ej: sub_xxx para Stripe) */
	@Column({ type: 'text', nullable: false })
	external_id: string;

	/** Sistema origen: stripe, chargebee, etc. Extensible para futuras integraciones. */
	@Column({ type: 'text', nullable: false, default: 'stripe' })
	source: string;

	@Column({ type: 'uuid', nullable: true })
	connection_id?: string;

	@Column({ type: 'text', nullable: false })
	status: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	start_date?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	canceled_at?: Date;

	@Column({ type: 'boolean', nullable: true, default: false })
	cancel_at_period_end?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	ended_at?: Date;

	@Column({ type: 'date', nullable: true })
	current_period_start?: Date;

	@Column({ type: 'date', nullable: true })
	current_period_end?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	billing_cycle_anchor?: Date;

	@Column({ type: 'text', nullable: true })
	cancellation_reason?: string;

	@Column({ type: 'text', nullable: true })
	cancellation_comment?: string;

	@Column({ type: 'text', nullable: false, default: 'USD' })
	currency: string;

	/** Suma de monthly_amount de todos los subscription_items activos */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, default: 0 })
	monthly_amount?: number;

	@Column({ type: 'text', nullable: true, default: 'charge_automatically' })
	collection_method?: string;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	/** Tipo de cambio de currency a system_currency. Default 1 cuando son iguales. */
	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 1 })
	fx_to_system?: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, default: 0 })
	monthly_amount_system_currency?: number;

	/** Campo libre editable por usuario de Sapira (único campo editable) */
	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_synced_at?: Date;

	@ManyToOne(() => Company, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscriptions_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscriptions_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => StripeConnection)
	@JoinColumn({ name: 'connection_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscriptions_connection_id_fkey' })
	connection?: StripeConnection; // entity existente (no se duplica)

	@ManyToOne(() => ClientEntity, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscriptions_client_entity_id_fkey' })
	clientEntity?: ClientEntity; // entity existente (no se duplica)

	@ManyToOne(() => Client, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscriptions_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)
}

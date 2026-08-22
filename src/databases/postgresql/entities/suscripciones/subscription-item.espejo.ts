import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Product } from '@/modules/odoo/entities/products.entity';

import { Subscription } from './subscription.espejo';

/**
 * Espejo de `public.subscription_items` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 456 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Items/líneas de una suscripción externa con pricing y producto mapeado a Sapira.
 * Referenciada por FK desde 2 tabla(s): invoice_items, revenue_schedule_monthly.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_subscription_items_updated_at · BEFORE UPDATE FOR EACH ROW → update_stripe_updated_at_column().
 * Policies (4): Users can delete their holding's subscription items (DELETE, public); Users can insert subscription items for their holdings (INSERT, public); Users can update their holding's subscription items (UPDATE, public); Users can view their holding's subscription items (SELECT, public).
 */
@Entity('subscription_items')
@Unique('uq_subscription_items_holding_external', ['holding_id', 'external_id'])
@Index('idx_subscription_items_external_id', ['external_id'])
@Index('idx_subscription_items_holding_id', ['holding_id'])
@Index('idx_subscription_items_product_id', ['product_id'])
@Index('idx_subscription_items_stripe_product_id', ['stripe_product_id'])
@Index('idx_subscription_items_subscription_id', ['subscription_id'])
export class SubscriptionItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'subscription_items_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	subscription_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	external_id: string;

	/** ID del producto en Stripe (ej: prod_xxx). Usado para mapeo via stripe_product_mappings. */
	@Column({ type: 'text', nullable: true })
	stripe_product_id?: string;

	/** ID del precio/plan en Stripe (ej: pay_per_vehicle_2025). */
	@Column({ type: 'text', nullable: true })
	stripe_price_id?: string;

	@Column({ type: 'uuid', nullable: true })
	product_id?: string;

	@Column({ type: 'text', nullable: true })
	product_name?: string;

	/** Tipo fijo para filtros y análisis MRR (ej: Digital). Desde Master Data. */
	@Column({ type: 'text', nullable: true, default: 'Digital' })
	item_type?: string;

	@Column({ type: 'numeric', precision: 18, scale: 4, nullable: true, default: 1 })
	quantity?: number;

	/** Precio unitario en la moneda de la suscripción. Ya convertido de centavos para Stripe (÷100). */
	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 0 })
	unit_price?: number;

	/** Calculado: quantity × unit_price */
	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, default: 0 })
	monthly_amount?: number;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	currency?: string;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 1 })
	fx_to_system?: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, default: 0 })
	unit_price_system_currency?: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true, default: 0 })
	monthly_amount_system_currency?: number;

	@Column({ type: 'text', nullable: true })
	billing_scheme?: string;

	@Column({ type: 'text', nullable: true, default: 'month' })
	interval?: string;

	@Column({ type: 'integer', nullable: true, default: 1 })
	interval_count?: number;

	@Column({ type: 'date', nullable: true })
	current_period_start?: Date;

	@Column({ type: 'date', nullable: true })
	current_period_end?: Date;

	@Column({ type: 'date', nullable: true })
	start_date?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	canceled_at?: Date;

	@Column({ type: 'jsonb', nullable: true, default: '[]' })
	discounts?: any;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscription_items_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'subscription_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscription_items_subscription_id_fkey' })
	subscription?: Subscription;

	@ManyToOne(() => Product, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'subscription_items_product_id_fkey' })
	product?: Product; // entity existente (no se duplica)
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Espejo de `public.salesforce_opportunities_cache` tal como está en producción.
 *
 * Los índices `idx_sf_opp_cache_close_date` e `idx_sf_opp_cache_sync_date` usan orden
 * descendente y no se pueden declarar con `@Index`: viven en `special-index/`.
 */
@Index('idx_sf_opp_cache_holding_id', ['holding_id'])
@Index('idx_sf_opp_cache_salesforce_id', ['salesforce_id'])
@Index('idx_sf_opp_cache_unique', ['holding_id', 'salesforce_id'], { unique: true })
@Entity({
	name: 'salesforce_opportunities_cache',
	comment:
		'Cache de oportunidades sincronizadas automáticamente desde Salesforce. Los usuarios ven estos datos en el frontend sin necesidad de sincronizar manualmente.',
})
export class SalesforceOpportunityCache {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_opportunities_cache_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	salesforce_id: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id: string;

	@Column({ type: 'text' })
	opportunity_name: string;

	@Column({ type: 'text', nullable: true })
	account_name: string;

	@Column({ type: 'text', nullable: true })
	account_country: string;

	@Column({ type: 'text', nullable: true })
	opportunity_type: string;

	@Column({ type: 'text', nullable: true })
	stage_name: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_won: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_closed: boolean;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	amount: number;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	currency_iso_code: string;

	@Column({ type: 'date', nullable: true })
	close_date: Date;

	@Column({ type: 'text', nullable: true })
	id_largo_oportunidad__c: string;

	@Column({ type: 'text', nullable: true })
	modalidad_de_pago__c: string;

	@Column({ type: 'text', nullable: true })
	forma_de_pago__c: string;

	@Column({ type: 'text', nullable: true })
	contrato__c: string;

	@Column({ type: 'text', nullable: true })
	orden_de_compra__c: string;

	@Column({ type: 'text', nullable: true })
	quote_project_manager__c: string;

	@Column({ type: 'text', nullable: true })
	quote_billing_email__c: string;

	@Column({ type: 'integer', nullable: true, default: 0 })
	line_items_count: number;

	@Column({
		type: 'jsonb',
		nullable: true,
		comment: 'Array JSON con los line items de la oportunidad (OpportunityLineItems + QuoteLineItems fusionados)',
	})
	line_items: any[];

	@Column({
		type: 'date',
		default: () => "('now'::text)::date",
		comment: 'Fecha de la sincronización (día de las oportunidades, no día de ejecución del cron)',
	})
	sync_date: Date;

	@CreateDateColumn({ type: 'timestamptz', nullable: true })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz', nullable: true })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'holding_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'salesforce_opportunities_cache_holding_id_fkey',
	})
	holding?: CompanyHolding;
}

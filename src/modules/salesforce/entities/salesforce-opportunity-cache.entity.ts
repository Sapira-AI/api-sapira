import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_opportunities_cache')
export class SalesforceOpportunityCache {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'varchar', length: 255 })
	salesforce_id: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	salesforce_account_id: string;

	@Column({ type: 'varchar', length: 500 })
	opportunity_name: string;

	@Column({ type: 'varchar', length: 500, default: 'Sin cuenta' })
	account_name: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	account_country: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	opportunity_type: string;

	@Column({ type: 'varchar', length: 100 })
	stage_name: string;

	@Column({ type: 'boolean', default: false })
	is_won: boolean;

	@Column({ type: 'boolean', default: false })
	is_closed: boolean;

	@Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
	amount: number;

	@Column({ type: 'varchar', length: 10, default: 'USD' })
	currency_iso_code: string;

	@Column({ type: 'date' })
	close_date: Date;

	@Column({ type: 'varchar', length: 255, nullable: true })
	id_largo_oportunidad__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	modalidad_de_pago__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	forma_de_pago__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	contrato__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	orden_de_compra__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	quote_project_manager__c: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	quote_billing_email__c: string;

	@Column({ type: 'int', default: 0 })
	line_items_count: number;

	@Column({ type: 'jsonb', nullable: true })
	line_items: any[];

	@Column({ type: 'date' })
	sync_date: Date;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}

import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Check('clients_status_check', `((status = ANY (ARRAY['Activo'::text, 'Inactivo'::text])))`)
@Index('idx_clients_client_number', ['client_number'])
@Index('idx_clients_holding_id', ['holding_id'])
@Index('idx_clients_salesforce_account_id', ['salesforce_account_id'], { where: `(salesforce_account_id IS NOT NULL)` })
@Index('idx_clients_salesforce_account_unique', ['salesforce_account_id', 'holding_id'], {
	unique: true,
	where: `(salesforce_account_id IS NOT NULL)`,
})
@Index('idx_clients_stripe_customer_id', ['stripe_customer_id'], { where: `(stripe_customer_id IS NOT NULL)` })
@Index('idx_clients_custom_fields', { synchronize: false })
@Entity('clients')
export class Client {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	name_commercial?: string;

	@Column({ type: 'text', nullable: true })
	segment?: string;

	@Column({ type: 'text', nullable: true })
	industry?: string;

	@Column({ type: 'text', nullable: true })
	market?: string;

	@Column({ type: 'text', nullable: true, default: 'Activo' })
	status?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	portal_enabled?: boolean;

	@Column({ type: 'date', nullable: true })
	client_since?: Date;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true, comment: 'ID de Cliente generado desde Salesforce (Account ID)' })
	client_number?: string;

	@Column({ type: 'jsonb', nullable: true, default: {}, comment: 'Campos personalizados definidos por el usuario en formato JSONB' })
	custom_fields?: any;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment: 'ID del cliente en Stripe, sincronizado desde BigQuery usando salesforce_account_id como clave de mapeo',
	})
	stripe_customer_id?: string;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'clients_holding_id_fkey' })
	holding?: CompanyHolding;
}

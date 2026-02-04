import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('clients')
@Index('idx_clients_client_number', ['client_number'])
@Index('idx_clients_holding_id', ['holding_id'])
@Index('idx_clients_salesforce_account_id', ['salesforce_account_id'], { where: 'salesforce_account_id IS NOT NULL' })
@Index('idx_clients_salesforce_account_unique', ['salesforce_account_id', 'holding_id'], {
	unique: true,
	where: 'salesforce_account_id IS NOT NULL',
})
export class Client {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

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
	created_at?: Date;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	client_number?: string;

	@Column({ type: 'jsonb', nullable: true, default: {} })
	custom_fields?: Record<string, any>;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string;
}

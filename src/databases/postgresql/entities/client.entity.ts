import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

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

	@CreateDateColumn({ type: 'timestamp without time zone' })
	created_at: Date;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	client_number?: string;

	@Column({ type: 'jsonb', nullable: true, default: {} })
	custom_fields?: any;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string;

	@Column({ type: 'text', nullable: true })
	stripe_customer_id?: string;
}

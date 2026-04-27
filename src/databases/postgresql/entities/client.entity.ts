import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('clients')
export class Client {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string;

	@Column({ type: 'text', nullable: true })
	address?: string;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	city?: string;

	@Column({ type: 'text', nullable: true })
	state?: string;

	@Column({ type: 'text', nullable: true })
	zip_code?: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	updated_at?: Date;

	@Column({ type: 'jsonb', nullable: true })
	metadata?: any;

	@Column({ type: 'text', nullable: true })
	stripe_customer_id?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string;
}

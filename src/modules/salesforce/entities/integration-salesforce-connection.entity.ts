import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('integration_salesforce_connections')
export class IntegrationSalesforceConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id: string;

	@Column({ type: 'varchar', length: 255 })
	name: string;

	@Column({ type: 'varchar', length: 255 })
	username: string;

	@Column({ type: 'varchar', length: 500, nullable: true })
	login_url: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	secret_reference: string;

	@Column({ type: 'varchar', length: 50, default: 'pending' })
	status: string;

	@Column({ type: 'text', nullable: true })
	error_message: string;

	@Column({ type: 'jsonb', nullable: true })
	metadata: any;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}

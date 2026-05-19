import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_connections')
export class SalesforceConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	user_id: string;

	@Column({ type: 'uuid', unique: true })
	holding_id: string;

	@Column({ type: 'varchar', length: 255 })
	username: string;

	@Column({ type: 'varchar', length: 255 })
	client_id: string;

	@Column({ type: 'varchar', length: 255 })
	client_secret: string;

	@Column({ type: 'varchar', length: 255 })
	security_token: string;

	@Column({ type: 'varchar', length: 255, default: 'https://login.salesforce.com' })
	login_url: string;

	@Column({ type: 'text', nullable: true })
	access_token: string;

	@Column({ type: 'text', nullable: true })
	refresh_token: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	instance_url: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	salesforce_user_id: string;

	@Column({ type: 'timestamp', nullable: true })
	token_issued_at: Date;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp', nullable: true })
	last_sync_at: Date;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}

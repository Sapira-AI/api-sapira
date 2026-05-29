import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum SalesforceAuthType {
	PASSWORD = 'password',
	CLIENT_CREDENTIALS = 'client_credentials',
}

@Entity('salesforce_connections')
export class SalesforceConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	user_id: string;

	@Column({ type: 'uuid', unique: true })
	holding_id: string;

	@Column({ type: 'text', nullable: true })
	username: string;

	@Column({ type: 'text', nullable: true })
	password: string;

	@Column({ type: 'text' })
	client_id: string;

	@Column({ type: 'text' })
	client_secret: string;

	@Column({ type: 'text', nullable: true })
	security_token: string;

	@Column({ type: 'text', default: 'https://login.salesforce.com' })
	login_url: string;

	@Column({ type: 'text', nullable: true })
	access_token: string;

	@Column({ type: 'text', nullable: true })
	refresh_token: string;

	@Column({ type: 'text', nullable: true })
	instance_url: string;

	@Column({ type: 'text', nullable: true })
	salesforce_user_id: string;

	@Column({ type: 'timestamp', nullable: true })
	token_issued_at: Date;

	@Column({ type: 'timestamp', nullable: true })
	token_expires_at: Date;

	@Column({
		type: 'enum',
		enum: SalesforceAuthType,
		default: SalesforceAuthType.PASSWORD,
	})
	auth_type: SalesforceAuthType;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp', nullable: true })
	last_sync_at: Date;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}

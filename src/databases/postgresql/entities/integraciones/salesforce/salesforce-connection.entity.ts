import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AuthUser } from '@/databases/postgresql/entities/auth-user.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

export enum SalesforceAuthType {
	PASSWORD = 'password',
	CLIENT_CREDENTIALS = 'client_credentials',
}

@Check('salesforce_connections_auth_type_check', `((auth_type = ANY (ARRAY['password'::text, 'client_credentials'::text])))`)
@Unique('salesforce_connections_holding_id_key', ['holding_id'])
@Index('idx_salesforce_connections_auth_type', ['auth_type'])
@Index('idx_salesforce_connections_holding_id', ['holding_id'])
@Index('idx_salesforce_connections_is_active', ['is_active'])
@Index('idx_salesforce_connections_user_id', ['user_id'])
@Entity('salesforce_connections')
export class SalesforceConnection {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_connections_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario que creó la conexión (nullable)' })
	user_id: string;

	@Column({
		type: 'uuid',
		unique: true,
		comment: 'Holding al que pertenece esta conexión. Una conexión es compartida por todos los usuarios del holding.',
	})
	holding_id: string;

	@Column({ type: 'text', nullable: true, comment: 'Username de Salesforce (requerido solo para auth_type = password)' })
	username: string;

	@Column({
		type: 'text',
		nullable: true,
		comment: 'Password del usuario de Salesforce (solo para auth_type = password, se usa para re-autenticar si expira el refresh_token)',
	})
	password: string;

	@Column({ type: 'text' })
	client_id: string;

	@Column({ type: 'text' })
	client_secret: string;

	@Column({ type: 'text', nullable: true, comment: 'Security token de Salesforce (requerido solo para auth_type = password)' })
	security_token: string;

	@Column({ type: 'text', default: 'https://login.salesforce.com', nullable: true })
	login_url: string;

	@Column({ type: 'text', nullable: true })
	access_token: string;

	@Column({ type: 'text', nullable: true, comment: 'Refresh token de Salesforce (solo para auth_type = password)' })
	refresh_token: string;

	@Column({ type: 'text', nullable: true })
	instance_url: string;

	@Column({ type: 'text', nullable: true })
	salesforce_user_id: string;

	@Column({ type: 'timestamptz', nullable: true })
	token_issued_at: Date;

	@Column({ type: 'timestamptz', nullable: true, comment: 'Timestamp de expiración del access token' })
	token_expires_at: Date;

	// En producción esta columna es `text` con un CHECK, no un enum de Postgres. Se declara como
	// `text` para no crear el tipo; `SalesforceAuthType` sigue siendo el tipo en TypeScript.
	@Column({
		type: 'text',
		default: SalesforceAuthType.CLIENT_CREDENTIALS,
		comment:
			'Tipo de autenticación: password (Username-Password Flow con refresh token) o client_credentials (Client Credentials Flow sin refresh token)',
		nullable: true,
	})
	auth_type: SalesforceAuthType;

	@Column({ type: 'boolean', default: true, nullable: true })
	is_active: boolean;

	@Column({ type: 'timestamptz', nullable: true })
	last_sync_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_connections_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_connections_user_id_fkey' })
	user?: AuthUser;
}

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('sii_configurations')
@Index(['holding_id', 'company_id'], { unique: true })
export class SiiConfiguration {
	@PrimaryGeneratedColumn('uuid')
	id!: string;
	@Column({ type: 'uuid' })
	holding_id!: string;
	@Column({ type: 'uuid' })
	company_id!: string;
	@Column({ type: 'text', default: 'certificacion' })
	environment!: 'certificacion' | 'produccion';
	@Column({ type: 'text', nullable: true })
	business_activity?: string;
	@Column({ type: 'jsonb', default: () => "'[]'" })
	activity_codes!: string[];
	@Column({ type: 'text', nullable: true })
	commune?: string;
	@Column({ type: 'text', nullable: true })
	city?: string;
	@Column({ type: 'text', nullable: true })
	region?: string;
	@Column({ type: 'integer', nullable: true })
	resolution_number?: number;
	@Column({ type: 'date', nullable: true })
	resolution_date?: string;
	@Column({ type: 'jsonb', default: () => "'[33,34,61]'" })
	enabled_document_types!: number[];
	@Column({ type: 'boolean', default: false })
	is_enabled!: boolean;
	@CreateDateColumn()
	created_at!: Date;
	@UpdateDateColumn()
	updated_at!: Date;
}

@Entity('sii_certificates')
@Index(['configuration_id'], { unique: true })
export class SiiCertificate {
	@PrimaryGeneratedColumn('uuid')
	id!: string;
	@Column({ type: 'uuid' })
	configuration_id!: string;
	@Column({ type: 'text' })
	key_vault_secret_name!: string;
	@Column({ type: 'text', nullable: true })
	thumbprint?: string;
	@Column({ type: 'text' })
	file_name!: string;
	@Column({ type: 'date', nullable: true })
	expires_at?: string;
	@Column({ type: 'boolean', default: true })
	is_active!: boolean;
	@CreateDateColumn()
	created_at!: Date;
}

@Entity('sii_cafs')
@Index(['configuration_id', 'document_type', 'folio_start', 'folio_end'], { unique: true })
export class SiiCaf {
	@PrimaryGeneratedColumn('uuid')
	id!: string;
	@Column({ type: 'uuid' })
	configuration_id!: string;
	@Column({ type: 'integer' })
	document_type!: number;
	@Column({ type: 'text' })
	blob_name!: string;
	@Column({ type: 'integer' })
	folio_start!: number;
	@Column({ type: 'integer' })
	folio_end!: number;
	@Column({ type: 'integer' })
	next_folio!: number;
	@Column({ type: 'boolean', default: true })
	is_active!: boolean;
	@CreateDateColumn()
	created_at!: Date;
}

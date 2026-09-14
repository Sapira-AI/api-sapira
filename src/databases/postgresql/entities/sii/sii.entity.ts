import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/** Espejo de `public.sii_configurations` tal como está en producción. */
@Unique('sii_configurations_holding_id_company_id_key', ['holding_id', 'company_id'])
@Entity('sii_configurations')
export class SiiConfiguration {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'sii_configurations_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid' })
	company_id!: string;

	@Column({ type: 'text', default: 'certificacion' })
	environment!: 'certificacion' | 'produccion';

	@Column({ type: 'text', nullable: true })
	business_activity?: string;

	@Column({ type: 'jsonb', default: [] })
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

	@Column({ type: 'jsonb', default: [33, 34, 61] })
	enabled_document_types!: number[];

	@Column({ type: 'boolean', default: false })
	is_enabled!: boolean;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	updated_at!: Date;

	// Producción no declara FKs sobre holding_id ni company_id en esta tabla.
	@ManyToOne(() => CompanyHolding, { createForeignKeyConstraints: false })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id' })
	holding?: CompanyHolding;

	@ManyToOne(() => Company, { createForeignKeyConstraints: false })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id' })
	company?: Company;
}

/** Espejo de `public.sii_certificates` tal como está en producción. */
@Unique('sii_certificates_configuration_id_key', ['configuration_id'])
@Entity('sii_certificates')
export class SiiCertificate {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'sii_certificates_pkey' })
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

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => SiiConfiguration, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'configuration_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'sii_certificates_configuration_id_fkey',
	})
	configuration?: SiiConfiguration;
}

/** Espejo de `public.sii_cafs` tal como está en producción. */
@Unique('sii_cafs_configuration_id_document_type_folio_start_folio_e_key', ['configuration_id', 'document_type', 'folio_start', 'folio_end'])
@Entity('sii_cafs')
export class SiiCaf {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'sii_cafs_pkey' })
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

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => SiiConfiguration, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'configuration_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'sii_cafs_configuration_id_fkey',
	})
	configuration?: SiiConfiguration;
}

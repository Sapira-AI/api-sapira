import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_entities')
export class ClientEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text', nullable: true })
	legal_name?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string;

	@Column({ type: 'integer', nullable: true })
	odoo_partner_id?: number;

	@Column({ type: 'integer', nullable: true })
	odoo_fiscal_position_id?: number;

	@Column({ type: 'text', nullable: true })
	odoo_fiscal_position_name?: string;

	@Column({ type: 'integer', nullable: true })
	odoo_reteica_tax_id?: number;

	@Column({ type: 'text', nullable: true })
	odoo_reteica_tax_name?: string;

	@Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
	odoo_reteica_tax_amount?: number;

	@Column({ type: 'integer', nullable: true })
	odoo_retefuente_tax_id?: number;

	@Column({ type: 'text', nullable: true })
	odoo_retefuente_tax_name?: string;

	@Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
	odoo_retefuente_tax_amount?: number;

	@Column({ type: 'integer', nullable: true })
	odoo_reteiva_tax_id?: number;

	@Column({ type: 'text', nullable: true })
	odoo_reteiva_tax_name?: string;

	@Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
	odoo_reteiva_tax_amount?: number;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

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
}

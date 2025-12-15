import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('companies')
export class Company {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'text' })
	holding_name!: string;

	@Column({ type: 'text', nullable: true })
	legal_name?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	currency?: string;

	@Column({ type: 'text', nullable: true })
	legal_address?: string;

	@Column({ type: 'text', nullable: true })
	representative_name?: string;

	@Column({ type: 'text', nullable: true })
	website?: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true })
	invoice_prefix?: string;

	@Column({ type: 'text', nullable: true })
	contract_prefix?: string;

	@Column({ type: 'numeric', nullable: true })
	tax_rate?: number;

	@Column({ type: 'text', nullable: true })
	logo_url?: string;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'integer', nullable: true })
	odoo_integration_id?: number;
}

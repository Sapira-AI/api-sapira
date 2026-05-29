import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_entities')
export class ClientEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', nullable: true })
	legal_name?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	legal_address?: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true })
	economic_activity?: string;

	@Column({ type: 'text', nullable: true })
	client_number?: string;

	@Column({ type: 'integer', nullable: true })
	odoo_partner_id?: number;

	@Column({ type: 'integer', nullable: true })
	odoo_fiscal_position_id?: number;

	@Column({ type: 'text', nullable: true })
	odoo_fiscal_position_name?: string;
}

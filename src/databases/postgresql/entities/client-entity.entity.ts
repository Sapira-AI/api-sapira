import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_entities')
@Index('idx_client_entities_client_number', ['client_number'])
@Index('idx_client_entities_holding_id', ['holding_id'])
@Index('idx_client_entities_odoo_partner_id', ['odoo_partner_id'], { where: 'odoo_partner_id IS NOT NULL' })
@Index('idx_client_entities_odoo_partner_holding', ['odoo_partner_id', 'holding_id'], {
	unique: true,
	where: 'odoo_partner_id IS NOT NULL',
})
export class ClientEntity {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

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

	@Column({ type: 'uuid', nullable: false, default: () => 'gen_random_uuid()' })
	holding_id!: string;

	@Column({ type: 'text', nullable: true })
	economic_activity?: string;

	@Column({ type: 'text', nullable: true })
	client_number?: string;

	@Column({ type: 'integer', nullable: true })
	odoo_partner_id?: number;
}

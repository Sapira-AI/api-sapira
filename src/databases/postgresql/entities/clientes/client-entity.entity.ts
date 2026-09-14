import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

@Index('idx_client_entities_client_number', ['client_number'])
@Index('idx_client_entities_holding_id', ['holding_id'])
@Index('idx_client_entities_odoo_partner_holding', ['odoo_partner_id', 'holding_id'], { unique: true, where: `(odoo_partner_id IS NOT NULL)` })
@Index('idx_client_entities_odoo_partner_id', ['odoo_partner_id'], { where: `(odoo_partner_id IS NOT NULL)` })
@Entity('client_entities')
export class ClientEntity {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_entities_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
	holding_id: string;

	@Column({ type: 'text', nullable: true })
	legal_name?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string | null;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	legal_address?: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true, comment: 'Giro o Actividad Económica del cliente' })
	economic_activity?: string;

	@Column({ type: 'text', nullable: true, comment: 'ID de Cliente generado desde Salesforce' })
	client_number?: string;

	@Column({
		type: 'integer',
		nullable: true,
		comment: 'ID del partner en Odoo. Usado para evitar duplicados y permitir actualizaciones en futuras sincronizaciones.',
	})
	odoo_partner_id?: number;

	@Column({ type: 'integer', nullable: true, comment: 'ID de la posición fiscal en Odoo (ej: 12 para "RC con ICA", 13 para "RC sin ICA")' })
	odoo_fiscal_position_id?: number;

	@Column({ type: 'text', nullable: true, comment: 'Nombre de la posición fiscal en Odoo (ej: "RC con ICA", "RC sin ICA")' })
	odoo_fiscal_position_name?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_client_entities_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_entities_client_id_fkey' })
	client?: Client;
}

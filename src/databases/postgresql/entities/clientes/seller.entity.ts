import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/** `crm_owner_id` (Integraciones v2, I1 `1791000000000-IntegrationsV2`): dueño del CRM que corresponde a este vendedor (D7). */
@Index('sellers_holding_crm_owner_key', ['holding_id', 'crm_owner_id'], { unique: true, where: '(crm_owner_id IS NOT NULL)' })
@Entity('sellers')
export class Seller {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	email: string;

	@Column({ type: 'text', nullable: true })
	phone: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;

	@Column({ type: 'text', nullable: true, comment: 'Id del dueño (usuario) en el CRM que corresponde a este vendedor. Único por holding' })
	crm_owner_id?: string | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_sellers_holding_id' })
	holding?: CompanyHolding;
}

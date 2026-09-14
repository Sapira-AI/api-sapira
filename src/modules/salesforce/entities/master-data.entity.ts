import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Unique('master_data_holding_id_category_value_key', ['holding_id', 'category', 'value'])
@Check(
	'master_data_category_check',
	"((category = ANY (ARRAY['markets'::text, 'segments'::text, 'industries'::text, 'item_types'::text, 'units_of_measure'::text, 'quote_types'::text, 'payment_terms'::text, 'contact_types'::text])))"
)
@Index('idx_master_data_category_active', ['holding_id', 'category', 'is_active'], { where: `(is_active = true)` })
@Index('idx_master_data_holding_id', ['holding_id'])
@Entity('master_data')
export class MasterData {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	category: string;

	@Column({ type: 'text' })
	value: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_data_holding_id' })
	holding?: CompanyHolding;
}

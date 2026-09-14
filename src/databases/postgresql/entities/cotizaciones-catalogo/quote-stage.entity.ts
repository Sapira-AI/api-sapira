import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('quote_stages_holding_id_name_key', ['holding_id', 'name'])
@Unique('quote_stages_holding_id_position_key', ['holding_id', 'position'])
@Entity('quote_stages')
export class QuoteStage {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'integer', default: 0 })
	position: number;

	@Column({ type: 'boolean', default: false })
	is_system_stage: boolean;

	@Column({ type: 'boolean', default: true })
	is_deletable: boolean;

	@Column({ type: 'text', nullable: true, default: '#3B82F6' })
	color: string;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_stages_holding_id_fkey' })
	holding?: CompanyHolding;
}

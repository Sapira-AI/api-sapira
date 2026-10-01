import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('quote_stages_holding_id_name_key', ['holding_id', 'name'])
@Unique('quote_stages_holding_id_position_key', ['holding_id', 'position'])
// Cotizaciones v2 (Q-A1, migración `1790650000000-QuotesV2`): kind de sistema; una sola etapa signed y una lost por holding
// (contract_created admite varias: "Contrato creado" y "Procesada previamente" conviven en SimpliRoute).
@Check(
	'quote_stages_kind_check',
	`(kind IS NULL) OR (kind = ANY (ARRAY['draft'::text, 'sent'::text, 'signed'::text, 'lost'::text, 'contract_created'::text]))`
)
@Index('idx_quote_stages_holding_kind_unique', ['holding_id', 'kind'], {
	unique: true,
	where: `(kind = ANY (ARRAY['signed'::text, 'lost'::text]))`,
})
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

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'v2 (Q-A1): kind de sistema draft | sent | signed | lost | contract_created. NULL cuenta como draft. Backfill por nombre en la migración QuotesV2',
	})
	kind?: string | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_stages_holding_id_fkey' })
	holding?: CompanyHolding;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { ConsumptionEntry, type ConsumptionSource } from '@/databases/postgresql/entities/contratos/consumption-entry.entity';

/**
 * `consumption_entry_revisions` — historial append-only de cada consumo (Pricing v2,
 * `docs/v2-rediseno/spec-pricing-v2.md` §2.3): una fila por revisión con lo que valía la entry en ese momento. Factura,
 * RSM, reportes y DWH leen solo `consumption_entries`; la pestaña Consumos muestra el historial desde acá.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790630000000-CreatePricingV2`. RLS por
 * holding con `rls/holding_access_consumption_entry_revisions.sql`.
 */
@Entity({
	name: 'consumption_entry_revisions',
	comment: 'Historial append-only de consumption_entries: una fila por revisión (nunca update destructivo sin rastro)',
})
@Unique('consumption_entry_revisions_entry_id_revision_key', ['entry_id', 'revision'])
@Index('idx_consumption_entry_revisions_holding_id', ['holding_id'])
export class ConsumptionEntryRevision {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'consumption_entry_revisions_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	entry_id: string;

	@Column({ type: 'integer' })
	revision: number;

	@Column({ type: 'numeric', precision: 18, scale: 6 })
	quantity: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	amount_override?: number | null;

	@Column({ type: 'boolean', default: true })
	apply_item_discount: boolean;

	@Column({ type: 'text' })
	source: ConsumptionSource;

	@Column({ type: 'text', nullable: true, comment: 'Motivo de la corrección (obligatorio desde la revisión 2)' })
	reason?: string | null;

	@Column({ type: 'uuid', nullable: true })
	changed_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	changed_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entry_revisions_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => ConsumptionEntry, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'entry_id', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entry_revisions_entry_id_fkey' })
	entry?: ConsumptionEntry;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'changed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'consumption_entry_revisions_changed_by_fkey' })
	changedBy?: User;
}

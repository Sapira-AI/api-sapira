import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { SalesforceSyncRun } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-sync-run.entity';

export type SalesforceSyncRunItemStatus = 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';

/** Espejo de `public.salesforce_sync_run_items` tal como está en producción. */
@Index('idx_salesforce_sync_run_items_run_status', ['run_id', 'status'])
@Unique('salesforce_sync_run_items_run_opportunity_unique', ['run_id', 'salesforce_opportunity_id'])
@Check(
	'salesforce_sync_run_items_status_check',
	"((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'error'::text, 'cancelled'::text])))"
)
@Entity('salesforce_sync_run_items')
export class SalesforceSyncRunItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_sync_run_items_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	run_id!: string;

	@ManyToOne(() => SalesforceSyncRun, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'run_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'salesforce_sync_run_items_run_id_fkey',
	})
	run!: SalesforceSyncRun;

	@Column({ type: 'text' })
	salesforce_opportunity_id!: string;

	@Column({ type: 'text', default: 'pending' })
	status!: SalesforceSyncRunItemStatus;

	@Column({ type: 'integer', default: 0 })
	attempts!: number;

	@Column({ type: 'timestamp', nullable: true })
	claimed_at?: Date | null;

	@Column({ type: 'text', nullable: true })
	error_message?: string | null;

	@Column({ type: 'timestamp', nullable: true })
	processed_at?: Date | null;

	@Column({ type: 'timestamp', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp', default: () => 'now()' })
	updated_at!: Date;
}

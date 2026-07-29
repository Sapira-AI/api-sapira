import { Column, CreateDateColumn, Entity, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { SalesforceSyncRun } from './salesforce-sync-run.entity';

export type SalesforceSyncRunItemStatus = 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';

@Entity('salesforce_sync_run_items')
@Index(['run_id', 'salesforce_opportunity_id'], { unique: true })
@Index(['run_id', 'status'])
export class SalesforceSyncRunItem {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	run_id!: string;

	@ManyToOne(() => SalesforceSyncRun, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'run_id' })
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

	@CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;
}

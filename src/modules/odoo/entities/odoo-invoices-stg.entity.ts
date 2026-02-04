import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('odoo_invoices_stg')
export class OdooInvoicesStg {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'integer', nullable: false })
	odoo_id!: number;

	@Column({ type: 'jsonb', nullable: false })
	raw_data!: any;

	@Column({ type: 'uuid', nullable: true })
	sync_batch_id?: string;

	@Column({ type: 'text', nullable: true, default: 'pending' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true })
	integration_batch_id?: string;

	@Column({ type: 'timestamp', nullable: true })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string;

	@Column({ type: 'uuid', nullable: true })
	sync_session_id?: string;
}

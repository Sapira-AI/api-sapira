import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('odoo_partners_stg')
export class OdooPartnersStg {
	@PrimaryGeneratedColumn('increment')
	id!: number;

	@Column({ type: 'integer', nullable: false })
	odoo_id!: number;

	@Column({ type: 'jsonb', nullable: false })
	raw_data!: any;

	@Column({ type: 'timestamp', nullable: true })
	processed_at?: Date;

	@Column({ type: 'text', nullable: true })
	sync_batch_id?: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;

	@Column({ type: 'text', nullable: true, default: 'processed' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true })
	integration_batch_id?: string;

	@Column({ type: 'timestamp', nullable: true })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;
}

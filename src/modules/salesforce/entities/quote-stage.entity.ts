import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

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
}

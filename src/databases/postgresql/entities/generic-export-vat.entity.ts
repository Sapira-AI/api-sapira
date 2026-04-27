import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('generic_export_vats')
export class GenericExportVat {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	tax_id: string;

	@Column({ type: 'text' })
	vat: string;

	@Column({ type: 'text' })
	company_name: string;

	@Column({ type: 'text', nullable: true })
	address?: string;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'numeric', nullable: true })
	vat_rate?: number;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	updated_at?: Date;

	@Column({ type: 'jsonb', nullable: true })
	metadata?: any;
}

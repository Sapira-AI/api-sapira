import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from './invoice.entity';

@Entity('invoice_references')
export class InvoiceReference {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	invoice_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	document_number: string;

	@Column({ type: 'text' })
	document_type_code: string;

	@Column({ type: 'text', nullable: true })
	document_type_name?: string;

	@Column({ type: 'text', nullable: true })
	reference_code?: string;

	@Column({ type: 'text', nullable: true })
	reason?: string;

	@Column({ type: 'date', nullable: true })
	reference_date?: Date;

	@Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => Invoice)
	@JoinColumn({ name: 'invoice_id' })
	invoice: Invoice;
}

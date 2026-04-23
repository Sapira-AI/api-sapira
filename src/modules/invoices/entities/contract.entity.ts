import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('contracts')
export class Contract {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'text', nullable: true })
	invoice_terms_and_conditions?: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	contract_number?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;
}

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_contacts')
export class ClientContact {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	client_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', nullable: true })
	contact_type: string;

	@Column({ type: 'text', nullable: true })
	name: string;

	@Column({ type: 'text', nullable: true })
	position: string;

	@Column({ type: 'text', nullable: true })
	email: string;

	@Column({ type: 'text', nullable: true })
	phone: string;
}

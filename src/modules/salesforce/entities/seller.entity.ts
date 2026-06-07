import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('sellers')
export class Seller {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	email: string;

	@Column({ type: 'text', nullable: true })
	phone: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;
}

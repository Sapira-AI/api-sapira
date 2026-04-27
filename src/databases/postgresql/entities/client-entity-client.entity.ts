import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_entity_clients')
export class ClientEntityClient {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	client_entity_id: string;

	@Column({ type: 'uuid' })
	client_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'boolean', default: false })
	is_primary: boolean;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	updated_at?: Date;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;
}

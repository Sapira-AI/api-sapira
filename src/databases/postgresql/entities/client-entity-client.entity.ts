import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('client_entity_clients')
@Index('idx_client_entity_clients_client', ['client_id'])
@Index('idx_client_entity_clients_entity', ['client_entity_id'])
@Index('idx_client_entity_clients_holding', ['holding_id'])
@Index('idx_client_entity_clients_primary', ['is_primary'], { where: 'is_primary = true' })
@Index('unique_entity_client', ['client_entity_id', 'client_id'], { unique: true })
export class ClientEntityClient {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: false })
	client_entity_id!: string;

	@Column({ type: 'uuid', nullable: false })
	client_id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'boolean', nullable: false, default: false })
	is_primary!: boolean;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;
}

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AuthUser } from '@/databases/postgresql/entities/auth-user.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

@Unique('unique_entity_client', ['client_entity_id', 'client_id'])
@Index('idx_client_entity_clients_client', ['client_id'])
@Index('idx_client_entity_clients_entity', ['client_entity_id'])
@Index('idx_client_entity_clients_holding', ['holding_id'])
@Index('idx_client_entity_clients_primary', ['is_primary'], { where: `(is_primary = true)` })
@Entity({
	name: 'client_entity_clients',
	comment:
		'Tabla de relación muchos-a-muchos entre client_entities y clients. Permite que una razón social esté asignada a múltiples clientes comerciales.',
})
export class ClientEntityClient {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_entity_clients_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	client_entity_id: string;

	@Column({ type: 'uuid' })
	client_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({
		type: 'boolean',
		default: false,
		comment: 'Indica si este es el cliente comercial principal para esta razón social. Solo uno puede ser primary por entidad.',
	})
	is_primary: boolean;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_entity_clients_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => ClientEntity, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_entity_clients_client_entity_id_fkey' })
	clientEntity?: ClientEntity;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_entity_clients_client_id_fkey' })
	client?: Client;

	@ManyToOne(() => AuthUser)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'client_entity_clients_created_by_fkey' })
	createdBy?: AuthUser;
}

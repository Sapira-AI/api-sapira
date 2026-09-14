import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Client } from '@/databases/postgresql/entities/client.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Index('idx_client_contacts_holding_id', ['holding_id'])
@Entity('client_contacts')
export class ClientContact {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id: string;

	// Anomalía heredada de producción: un INSERT que omita la columna genera un UUID
	// aleatorio que siempre viola la FK. Se replica tal cual; corregirlo es otro cambio.
	@Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
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

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_client_contacts_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_contacts_client_id_fkey' })
	client?: Client;
}

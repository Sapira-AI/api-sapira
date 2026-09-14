import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AuthUser } from '@/databases/postgresql/entities/auth-user.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('bigquery_connections_holding_id_name_key', ['holding_id', 'name'])
@Index('idx_bigquery_connections_holding_id', ['holding_id'])
@Index('idx_bigquery_connections_is_active', ['is_active'])
@Index('idx_bigquery_connections_user_id', ['user_id'])
@Entity({
	name: 'bigquery_connections',
	comment: 'Configuración de conexiones a BigQuery por holding',
})
export class BigQueryConnection {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'bigquery_connections_pkey' })
	id: string;

	@Column({ type: 'uuid', comment: 'ID del holding al que pertenece esta conexión' })
	holding_id: string;

	@Column({ type: 'uuid', comment: 'ID del usuario que creó la conexión' })
	user_id: string;

	@Column({ type: 'text', comment: 'Nombre descriptivo de la conexión' })
	name: string;

	@Column({ type: 'text', comment: 'ID del proyecto de Google Cloud Platform' })
	project_id: string;

	@Column({ type: 'text', comment: 'Credenciales JSON de la cuenta de servicio de GCP' })
	credentials: string;

	@Column({ type: 'text', nullable: true, comment: 'ID del dataset específico (opcional)' })
	dataset_id?: string;

	@Column({ type: 'boolean', default: true, comment: 'Indica si la conexión está activa', nullable: true })
	is_active: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Timestamp de la última sincronización exitosa' })
	last_sync_at?: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bigquery_connections_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bigquery_connections_user_id_fkey' })
	user?: AuthUser;
}

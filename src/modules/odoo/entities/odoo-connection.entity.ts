import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AuthUser } from '@/databases/postgresql/entities/auth-user.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Unique('odoo_connections_holding_id_name_key', ['holding_id', 'name'])
@Index('idx_odoo_connections_holding_id', ['holding_id'])
@Index('idx_odoo_connections_is_active', ['is_active'])
@Index('idx_odoo_connections_user_id', ['user_id'])
@Entity({
	name: 'odoo_connections',
	comment: 'Configuración de conexiones a Odoo',
})
export class OdooConnection {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'odoo_connections_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	user_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: false, comment: 'URL del servidor Odoo' })
	url: string;

	@Column({ type: 'text', nullable: false, comment: 'API Key para autenticación con Odoo' })
	api_key: string;

	@Column({ type: 'text', nullable: false, comment: 'Nombre de la base de datos en Odoo' })
	database_name: string;

	@Column({ type: 'text', nullable: true, comment: 'Código de suscripción de Odoo' })
	subscription_code?: string;

	@Column({ type: 'text', nullable: true })
	username?: string;

	@Column({ type: 'boolean', nullable: true, default: true, comment: 'Indica si la conexión está activa' })
	is_active?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Timestamp de la última sincronización' })
	last_sync_at?: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_connections_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_connections_user_id_fkey' })
	user?: AuthUser;
}

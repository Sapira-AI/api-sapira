import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.roles` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 50 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Referenciada por FK desde 3 tabla(s): notification_role_subscriptions, role_permissions, users.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (5): Allow authenticated users to read roles (SELECT, authenticated); tenant_isolation_delete_roles (DELETE, authenticated); tenant_isolation_insert_roles (INSERT, authenticated); tenant_isolation_select_roles (SELECT, authenticated); tenant_isolation_update_roles (UPDATE, authenticated).
 */
@Entity('roles')
@Unique('roles_name_holding_id_key', ['name', 'holding_id'])
@Index('idx_roles_holding_id', ['holding_id'])
export class Role {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'roles_pkey' })
	id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_roles_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

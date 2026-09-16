import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

/**
 * Entity de `public.role_permissions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 637 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (5): Allow authenticated users to read role_permissions (SELECT, authenticated); tenant_isolation_delete_role_permissions (DELETE, authenticated); tenant_isolation_insert_role_permissions (INSERT, authenticated); tenant_isolation_select_role_permissions (SELECT, authenticated); tenant_isolation_update_role_permissions (UPDATE, authenticated).
 */
@Entity('role_permissions')
@Index('idx_role_permissions_holding_id', ['holding_id'])
@Index('idx_role_permissions_permission_id', ['permission_id'])
@Index('idx_role_permissions_role_id', ['role_id'])
export class RolePermission {
	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'role_permissions_pkey' })
	role_id: string;

	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'role_permissions_pkey' })
	permission_id: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_role_permissions_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Permission)
	@JoinColumn({ name: 'permission_id', referencedColumnName: 'id', foreignKeyConstraintName: 'role_permissions_permission_id_fkey' })
	permission?: Permission;

	@ManyToOne(() => Role)
	@JoinColumn({ name: 'role_id', referencedColumnName: 'id', foreignKeyConstraintName: 'role_permissions_role_id_fkey' })
	role?: Role;
}

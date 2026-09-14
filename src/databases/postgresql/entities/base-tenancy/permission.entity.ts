import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Espejo de `public.permissions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 22 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): role_permissions.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (3): Allow authenticated users to read permissions (SELECT, authenticated); Anyone can read permissions (SELECT, authenticated); System only can manage permissions (ALL, authenticated).
 */
@Entity('permissions')
@Unique('permissions_code_key', ['code'])
export class Permission {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'permissions_pkey' })
	id: string;

	@Column({ type: 'text', nullable: false })
	code: string;

	@Column({ type: 'text', nullable: true })
	description?: string;
}

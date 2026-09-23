import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Entity de `public.permissions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 22 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
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

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * Entity de `public.user_view_preferences` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 9 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Vistas guardadas por usuario y tipo de entidad. Cada vista persiste columnas + filtros + búsqueda. Aislada por usuario via RLS — no se comparte entre usuarios aunque sean del mismo holding.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: user_view_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_user_view_preferences_updated_at().
 * Policies (4): user_views_delete_own (DELETE, public); user_views_insert_own (INSERT, public); user_views_select_own (SELECT, public); user_views_update_own (UPDATE, public).
 */
@Entity({
	name: 'user_view_preferences',
	comment:
		'Vistas guardadas por usuario y tipo de entidad. Cada vista persiste columnas + filtros + búsqueda. Aislada por usuario via RLS — no se comparte entre usuarios aunque sean del mismo holding.',
})
@Unique('user_view_preferences_user_id_entity_type_view_name_key', ['user_id', 'entity_type', 'view_name'])
@Index('idx_user_view_prefs_one_default_per_entity', ['user_id', 'entity_type'], { unique: true, where: 'is_default = true' })
@Index('idx_user_view_prefs_user_entity', ['user_id', 'entity_type'])
export class UserViewPreference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'user_view_preferences_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	user_id: string;

	@Column({ type: 'text', nullable: false })
	entity_type: string;

	@Column({ type: 'text', nullable: false, default: 'Mi Vista' })
	view_name: string;

	/** Array de configuración de columnas: [{key, label, visible}]. */
	@Column({ type: 'jsonb', comment: 'Array de configuración de columnas: [{key, label, visible}].', nullable: false })
	column_config: any;

	/** Snapshot del FilterState: { quickFilters, advancedFilters, searchQuery }. Fechas como ISO string. */
	@Column({
		type: 'jsonb',
		comment: 'Snapshot del FilterState: { quickFilters, advancedFilters, searchQuery }. Fechas como ISO string.',
		nullable: false,
		default: '{}',
	})
	filter_config: any;

	/** Solo una vista por (user_id, entity_type) puede tener is_default=true (garantizado por idx_user_view_prefs_one_default_per_entity). Se carga al entrar al módulo. */
	@Column({
		type: 'boolean',
		comment:
			'Solo una vista por (user_id, entity_type) puede tener is_default=true (garantizado por idx_user_view_prefs_one_default_per_entity). Se carga al entrar al módulo.',
		nullable: false,
		default: false,
	})
	is_default: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_view_preferences_user_id_fkey' })
	user?: User; // entity existente (no se duplica)
}

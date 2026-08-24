import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.user_view_preferences` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 8 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Vistas guardadas por usuario y tipo de entidad. Cada vista persiste columnas + filtros + búsqueda. Aislada por usuario via RLS — no se comparte entre usuarios aunque sean del mismo holding.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: user_view_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_user_view_preferences_updated_at().
 * Policies (4): user_views_delete_own (DELETE, public); user_views_insert_own (INSERT, public); user_views_select_own (SELECT, public); user_views_update_own (UPDATE, public).
 */
@Entity('user_view_preferences')
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
	@Column({ type: 'jsonb', nullable: false })
	column_config: any;

	/** Snapshot del FilterState: { quickFilters, advancedFilters, searchQuery }. Fechas como ISO string. */
	@Column({ type: 'jsonb', nullable: false, default: '{}' })
	filter_config: any;

	/** Solo una vista por (user_id, entity_type) puede tener is_default=true (garantizado por idx_user_view_prefs_one_default_per_entity). Se carga al entrar al módulo. */
	@Column({ type: 'boolean', nullable: false, default: false })
	is_default: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_view_preferences_user_id_fkey' })
	user?: User; // entity existente (no se duplica)
}

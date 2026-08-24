import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Espejo de `public.client_entity_tax_id_normalization_conflicts` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 65 filas · RLS OFF.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Registro histórico de tax_id duplicados detectados antes de normalizar. Los duplicados se conservan y la integración debe resolverlos de forma determinista.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (0): ninguna (RLS OFF).
 */
@Entity('client_entity_tax_id_normalization_conflicts')
@Unique('client_entity_tax_id_normaliz_migration_name_client_entity__key', ['migration_name', 'client_entity_id'])
export class ClientEntityTaxIdNormalizationConflict {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_entity_tax_id_normalization_conflicts_pkey' })
	id: string;

	@Column({ type: 'text', nullable: false })
	migration_name: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	client_entity_id: string;

	@Column({ type: 'uuid', array: true, nullable: false })
	conflicting_client_entity_ids: string[];

	@Column({ type: 'text', nullable: false })
	tax_id_current: string;

	@Column({ type: 'text', nullable: false })
	tax_id_normalized: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	detected_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	resolved_at?: Date;
}

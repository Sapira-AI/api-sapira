import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.custom_field_definitions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 16 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Definiciones de campos personalizados creados por usuarios a nivel de holding
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): custom_field_definitions_delete (DELETE, public); custom_field_definitions_insert (INSERT, public); custom_field_definitions_select (SELECT, public); custom_field_definitions_update (UPDATE, public).
 */
@Entity('custom_field_definitions')
@Unique('unique_field_per_entity', ['holding_id', 'entity_type', 'field_name'])
@Check('custom_field_definitions_field_type_check', "field_type = ANY (ARRAY['text'::text, 'number'::text])")
@Check(
	'valid_entity_type',
	"entity_type = ANY (ARRAY['client'::text, 'contract'::text, 'contract_item'::text, 'quote'::text, 'quote_item'::text, 'invoice'::text, 'invoice_item'::text])"
)
@Index('idx_custom_field_defs_active', ['holding_id', 'entity_type', 'is_active'], { where: 'is_active = true' })
@Index('idx_custom_field_defs_holding_entity', ['holding_id', 'entity_type'])
@Index('idx_custom_field_defs_order', ['holding_id', 'entity_type', 'display_order', 'created_at'])
export class CustomFieldDefinition {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'custom_field_definitions_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	entity_type: string;

	/** Identificador único del campo en snake_case (ej: proyecto_cliente) */
	@Column({ type: 'text', nullable: false })
	field_name: string;

	/** Label visible para el usuario (ej: Proyecto del Cliente) */
	@Column({ type: 'text', nullable: false })
	field_label: string;

	/** Tipo de dato: text o number */
	@Column({ type: 'text', nullable: false })
	field_type: string;

	@Column({ type: 'boolean', nullable: false, default: false })
	is_required: boolean;

	/** Permite ocultar campos sin eliminarlos */
	@Column({ type: 'boolean', nullable: false, default: true })
	is_active: boolean;

	/** Orden de visualización en formularios */
	@Column({ type: 'integer', nullable: false, default: 0 })
	display_order: number;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'custom_field_definitions_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'custom_field_definitions_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)
}

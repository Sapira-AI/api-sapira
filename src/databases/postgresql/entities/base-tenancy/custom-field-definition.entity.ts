import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * Entity de `public.custom_field_definitions` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 16 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Definiciones de campos personalizados creados por usuarios a nivel de holding
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): custom_field_definitions_delete (DELETE, public); custom_field_definitions_insert (INSERT, public); custom_field_definitions_select (SELECT, public); custom_field_definitions_update (UPDATE, public).
 */
@Entity({ name: 'custom_field_definitions', comment: 'Definiciones de campos personalizados creados por usuarios a nivel de holding' })
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
	@Column({ type: 'text', comment: 'Identificador único del campo en snake_case (ej: proyecto_cliente)', nullable: false })
	field_name: string;

	/** Label visible para el usuario (ej: Proyecto del Cliente) */
	@Column({ type: 'text', comment: 'Label visible para el usuario (ej: Proyecto del Cliente)', nullable: false })
	field_label: string;

	/** Tipo de dato: text o number */
	@Column({ type: 'text', comment: 'Tipo de dato: text o number', nullable: false })
	field_type: string;

	@Column({ type: 'boolean', nullable: false, default: false })
	is_required: boolean;

	/** Permite ocultar campos sin eliminarlos */
	@Column({ type: 'boolean', comment: 'Permite ocultar campos sin eliminarlos', nullable: false, default: true })
	is_active: boolean;

	/** Orden de visualización en formularios */
	@Column({ type: 'integer', comment: 'Orden de visualización en formularios', nullable: false, default: 0 })
	display_order: number;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'custom_field_definitions_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'custom_field_definitions_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

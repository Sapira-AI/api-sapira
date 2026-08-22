import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

/**
 * Espejo de `public.odoo_object_mappings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Mapeo entre objetos de Odoo y registros de Sapira
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_update_odoo_mapping_timestamp · BEFORE UPDATE FOR EACH ROW → update_odoo_mapping_updated_at().
 * Policies (4): Users can delete odoo mappings from their holding (DELETE, public); Users can insert odoo mappings for their holding (INSERT, public); Users can update odoo mappings from their holding (UPDATE, public); Users can view odoo mappings from their holding (SELECT, public).
 */
@Entity('odoo_object_mappings')
@Unique('unique_odoo_object_per_holding', ['holding_id', 'odoo_object_type', 'odoo_object_id'])
@Index('idx_odoo_object_mappings_holding', ['holding_id'])
@Index('idx_odoo_object_mappings_odoo_lookup', ['holding_id', 'odoo_object_type', 'odoo_object_id'])
@Index('idx_odoo_object_mappings_sapira_lookup', ['holding_id', 'sapira_table_name', 'sapira_record_id'])
export class OdooObjectMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'odoo_object_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	/** Tipo de objeto en Odoo (invoice, client, etc) */
	@Column({ type: 'text', nullable: false })
	odoo_object_type: string;

	/** ID del objeto en Odoo */
	@Column({ type: 'text', nullable: false })
	odoo_object_id: string;

	/** Nombre de la tabla en Sapira */
	@Column({ type: 'text', nullable: false })
	sapira_table_name: string;

	/** ID del registro en Sapira */
	@Column({ type: 'uuid', nullable: false })
	sapira_record_id: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	last_synced_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_object_mappings_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

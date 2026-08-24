import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Espejo de `public.invoice_trigger_debug_logs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS OFF.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Tabla temporal para debugging de triggers de facturas. ELIMINAR después del debugging.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (0): ninguna (RLS OFF).
 */
@Entity('invoice_trigger_debug_logs')
export class InvoiceTriggerDebugLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_trigger_debug_logs_pkey' })
	id: string;

	@Column({ type: 'text', nullable: false })
	trigger_name: string;

	@Column({ type: 'text', nullable: false })
	operation: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	odoo_id?: string;

	@Column({ type: 'jsonb', nullable: true })
	raw_data_sample?: any;

	@Column({ type: 'text', nullable: true })
	processing_status?: string;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;
}

import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

/**
 * Espejo de `public.overdue_check_log` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 68 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Registro de ejecuciones de la verificación automática de facturas vencidas.
 *    Tabla de auditoría del sistema con RLS habilitado.
 *    holding_id NULL indica ejecución global que afecta múltiples holdings.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): Service role can manage all overdue check logs (ALL, service_role); Users can view overdue check logs from their holding (SELECT, authenticated).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_overdue_check_log_date ON public.overdue_check_log USING btree (check_date DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_overdue_check_log_holding_id ON public.overdue_check_log USING btree (holding_id, created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_overdue_check_log_status ON public.overdue_check_log USING btree (status, created_at DESC)
 */
@Entity('overdue_check_log')
@Check('overdue_check_log_status_check', "status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])")
export class OverdueCheckLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'overdue_check_log_pkey' })
	id: string;

	@Column({ type: 'date', nullable: false })
	check_date: Date;

	@Column({ type: 'integer', nullable: false, default: 0 })
	invoices_found: number;

	@Column({ type: 'integer', nullable: false, default: 0 })
	invoices_updated: number;

	@Column({ type: 'uuid', array: true, nullable: true, default: () => 'ARRAY[]::uuid[]' })
	holdings_affected?: string[];

	@Column({ type: 'integer', nullable: true })
	execution_time_ms?: number;

	@Column({ type: 'text', nullable: false })
	status: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	/** ID del holding. NULL indica ejecución global del sistema que afecta múltiples holdings. */
	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'overdue_check_log_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

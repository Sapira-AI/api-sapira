import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.contract_item_change_log` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1154 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Audit log de cambios en contract_items para contratos post-firma (Activo/Cancelado/Expirado). Trazabilidad de qué cambió, quién, cuándo y por qué.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): cicl_select (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_cicl_changed_by ON public.contract_item_change_log USING btree (changed_by, changed_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_cicl_company ON public.contract_item_change_log USING btree (company_id, changed_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_cicl_contract ON public.contract_item_change_log USING btree (contract_id, changed_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_cicl_item ON public.contract_item_change_log USING btree (contract_item_id, changed_at DESC)
 */
@Entity('contract_item_change_log')
@Check('contract_item_change_log_change_type_check', "change_type = ANY (ARRAY['CREATE'::text, 'UPDATE'::text, 'DELETE'::text])")
export class ContractItemChangeLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_item_change_log_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_item_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	changed_at: Date;

	@Column({ type: 'uuid', nullable: true })
	changed_by?: string;

	@Column({ type: 'text', nullable: true })
	changed_by_name?: string;

	@Column({ type: 'text', nullable: true })
	changed_by_email?: string;

	@Column({ type: 'text', nullable: false })
	change_type: string;

	@Column({ type: 'text', array: true, nullable: true })
	fields_changed?: string[];

	@Column({ type: 'jsonb', nullable: true })
	before_values?: any;

	@Column({ type: 'jsonb', nullable: true })
	after_values?: any;

	@Column({ type: 'text', nullable: true })
	reason?: string;

	@Column({ type: 'text', nullable: true })
	source?: string;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'changed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_change_log_changed_by_fkey' })
	changedBy?: User; // entity existente (no se duplica)
}

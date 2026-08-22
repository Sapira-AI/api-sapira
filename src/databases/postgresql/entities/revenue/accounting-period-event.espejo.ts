import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.accounting_period_events` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 14 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Audit log inmutable de cierres y reaperturas de períodos. Cada fila captura el movimiento de cutoff_date, motivo y snapshot del usuario.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_events_validate_company_holding · BEFORE INSERT FOR EACH ROW → trg_validate_cutoff_company_holding_match().
 * Policies (2): events_insert (INSERT, public); events_select (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_period_events_company_time ON public.accounting_period_events USING btree (holding_id, company_id, performed_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_period_events_performed_by ON public.accounting_period_events USING btree (performed_by, performed_at DESC)
 */
@Entity('accounting_period_events')
@Check('accounting_period_events_action_check', "action = ANY (ARRAY['CLOSED'::text, 'REOPENED'::text])")
@Check('accounting_period_events_reason_check', 'length(TRIM(BOTH FROM reason)) >= 10')
export class AccountingPeriodEvent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'accounting_period_events_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	action: string;

	@Column({ type: 'date', nullable: true })
	cutoff_date_before?: Date;

	@Column({ type: 'date', nullable: false })
	cutoff_date_after: Date;

	@Column({ type: 'uuid', nullable: false })
	performed_by: string;

	@Column({ type: 'text', nullable: false })
	performed_by_name: string;

	@Column({ type: 'text', nullable: false })
	performed_by_email: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	performed_at: Date;

	@Column({ type: 'text', nullable: false })
	reason: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_events_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Company, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_events_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => User, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'performed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_events_performed_by_fkey' })
	performedBy?: User; // entity existente (no se duplica)
}

import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

/**
 * Entity de `public.invoice_restructure_log` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 312 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): restructure_log_insert (INSERT, public); restructure_log_select (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_invoice_restructure_log_contract ON public.invoice_restructure_log USING btree (contract_id, created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_invoice_restructure_log_holding_action ON public.invoice_restructure_log USING btree (holding_id, action, created_at DESC)
 */
@Entity('invoice_restructure_log')
@Check(
	'invoice_restructure_log_action_check',
	"action = ANY (ARRAY['update_item_descriptions'::text, 'update_terms'::text, 'reassign_entity'::text, 'restructure'::text, 'split'::text, 'merge'::text, 'item_sync'::text, 'item_delete_sync'::text])"
)
export class InvoiceRestructureLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_restructure_log_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: true })
	actor_user_id?: string;

	@Column({ type: 'text', nullable: false })
	action: string;

	@Column({ type: 'jsonb', nullable: false })
	payload: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'actor_user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_restructure_log_actor_user_id_fkey' })
	actorUser?: User; // entity existente (no se duplica)

	@ManyToOne(() => Contract)
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_restructure_log_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)
}

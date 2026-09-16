import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

/**
 * Entity de `public.contract_notifications` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 13 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (3): Users can insert contract notifications for their holding (INSERT, public); Users can update their contract notifications (UPDATE, public); Users can view their holding's contract notifications (SELECT, public).
 */
@Entity('contract_notifications')
@Check(
	'contract_notifications_notification_type_check',
	"notification_type = ANY (ARRAY['step_assigned'::text, 'step_completed'::text, 'overdue_alert'::text, 'validation_required'::text, 'client_action_needed'::text])"
)
@Index('idx_contract_notifications_contract_id', ['contract_id'])
@Index('idx_contract_notifications_created_at', ['created_at'])
@Index('idx_contract_notifications_is_read', ['is_read'])
@Index('idx_contract_notifications_user_id', ['user_id'])
export class ContractNotification {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_notifications_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: true })
	user_id?: string;

	@Column({ type: 'text', nullable: false })
	notification_type: string;

	@Column({ type: 'text', nullable: false })
	title: string;

	@Column({ type: 'text', nullable: false })
	message: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_read?: boolean;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_notifications_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_notifications_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_notifications_user_id_fkey' })
	user?: User; // entity existente (no se duplica)
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.billing_references` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): invoice_reference_links.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_billing_references (DELETE, public); tenant_isolation_insert_billing_references (INSERT, public); tenant_isolation_select_billing_references (SELECT, public); tenant_isolation_update_billing_references (UPDATE, public).
 */
@Entity('billing_references')
@Index('idx_billing_references_contract', ['contract_id'])
@Index('idx_billing_references_holding', ['holding_id'])
@Index('idx_billing_references_status', ['status'])
export class BillingReference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'billing_references_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'enum', enum: ['PO', 'HES', 'ACCEPTANCE', 'OTHER'], enumName: 'reference_type_enum', nullable: false })
	reference_type: string;

	@Column({ type: 'text', nullable: false })
	reference_code: string;

	@Column({ type: 'text', nullable: true })
	issuer?: string;

	@Column({ type: 'date', nullable: true })
	issue_date?: Date;

	@Column({ type: 'date', nullable: false })
	valid_from: Date;

	@Column({ type: 'date', nullable: true })
	valid_to?: Date;

	@Column({ type: 'boolean', nullable: true, default: false })
	covers_multiple_invoices?: boolean;

	@Column({ type: 'enum', enum: ['Active', 'Expired', 'Cancelled'], enumName: 'reference_status_enum', nullable: true, default: 'Active' })
	status?: string;

	@Column({ type: 'text', nullable: true })
	file_url?: string;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	file_metadata?: any;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'billing_references_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'billing_references_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'billing_references_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)
}

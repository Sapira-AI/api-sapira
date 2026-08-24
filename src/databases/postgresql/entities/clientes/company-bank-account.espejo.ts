import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.company_bank_accounts` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 2 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): bank_upload_batches.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): financial_managers_can_delete_bank_accounts (DELETE, authenticated); financial_managers_can_insert_bank_accounts (INSERT, authenticated); financial_managers_can_update_bank_accounts (UPDATE, authenticated); financial_users_can_view_bank_accounts (SELECT, authenticated).
 */
@Entity('company_bank_accounts')
export class CompanyBankAccount {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'company_bank_accounts_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	bank_name: string;

	@Column({ type: 'text', nullable: false })
	account_type: string;

	@Column({ type: 'text', nullable: false })
	account_number: string;

	@Column({ type: 'text', nullable: false })
	currency: string;

	@Column({ type: 'text', nullable: true })
	account_holder?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'company_bank_accounts_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}

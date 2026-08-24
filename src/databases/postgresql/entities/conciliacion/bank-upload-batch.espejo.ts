import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { CompanyBankAccount } from '../clientes/company-bank-account.espejo';

/**
 * Espejo de `public.bank_upload_batches` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): bank_movements.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_bank_upload_batches (DELETE, authenticated); tenant_isolation_insert_bank_upload_batches (INSERT, authenticated); tenant_isolation_select_bank_upload_batches (SELECT, authenticated); tenant_isolation_update_bank_upload_batches (UPDATE, authenticated).
 */
@Entity('bank_upload_batches')
@Check('bank_upload_batches_status_check', "status = ANY (ARRAY['Procesado'::text, 'Revertido'::text])")
export class BankUploadBatch {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'bank_upload_batches_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'uuid', nullable: true })
	bank_account_id?: string;

	@Column({ type: 'text', nullable: false })
	file_name: string;

	@Column({ type: 'text', nullable: true })
	file_hash?: string;

	@Column({ type: 'integer', nullable: false, default: 0 })
	row_count: number;

	@Column({ type: 'jsonb', nullable: false })
	column_mapping: any;

	@Column({ type: 'text', nullable: false, default: 'Procesado' })
	status: string;

	@Column({ type: 'uuid', nullable: true })
	uploaded_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_upload_batches_uploaded_by_fkey' })
	uploadedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyBankAccount)
	@JoinColumn({ name: 'bank_account_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_upload_batches_bank_account_id_fkey' })
	bankAccount?: CompanyBankAccount; // espejo de otro módulo
}

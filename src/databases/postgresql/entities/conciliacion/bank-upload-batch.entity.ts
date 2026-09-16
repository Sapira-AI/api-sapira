import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

import { CompanyBankAccount } from '../clientes/company-bank-account.entity';

/**
 * Entity de `public.bank_upload_batches` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 10 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
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

	@ManyToOne(() => CompanyBankAccount)
	@JoinColumn({ name: 'bank_account_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_upload_batches_bank_account_id_fkey' })
	bankAccount?: CompanyBankAccount; // de otro módulo

	@ManyToOne(() => User)
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_upload_batches_uploaded_by_fkey' })
	uploadedBy?: User; // entity existente (no se duplica)
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.contract_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 2 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): Users can delete contract documents in their holding (DELETE, public); Users can insert contract documents for their holding (INSERT, public); Users can update contract documents in their holding (UPDATE, public); Users can view contract documents in their holding (SELECT, public).
 */
@Entity('contract_documents')
@Index('idx_contract_documents_contract_id', ['contract_id'])
@Index('idx_contract_documents_holding_id', ['holding_id'])
export class ContractDocument {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_documents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'text', nullable: false })
	document_name: string;

	@Column({ type: 'text', nullable: false })
	file_url: string;

	@Column({ type: 'bigint', nullable: true })
	file_size?: string;

	@Column({ type: 'text', nullable: true })
	file_type?: string;

	@Column({ type: 'text', nullable: true, default: 'Otros' })
	category?: string;

	@Column({ type: 'uuid', nullable: true })
	uploaded_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	uploaded_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_documents_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_documents_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_documents_uploaded_by_fkey' })
	uploadedBy?: User; // entity existente (no se duplica)
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

/**
 * Entity de `public.contract_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 2 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
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

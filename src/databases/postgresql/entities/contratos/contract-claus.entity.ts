import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.contract_clauses` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 18 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_contract_clauses (DELETE, authenticated); tenant_isolation_insert_contract_clauses (INSERT, authenticated); tenant_isolation_select_contract_clauses (SELECT, authenticated); tenant_isolation_update_contract_clauses (UPDATE, authenticated).
 */
@Entity('contract_clauses')
@Index('idx_contract_clauses_holding_id', ['holding_id'])
export class ContractClaus {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_clauses_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'text', nullable: true })
	category?: string;

	@Column({ type: 'text', nullable: true })
	content?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_clauses_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_clauses_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

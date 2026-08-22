import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.company_legal_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): holding_access_legal_documents (ALL, public).
 */
@Entity('company_legal_documents')
export class CompanyLegalDocument {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'company_legal_documents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	document_name: string;

	@Column({ type: 'text', nullable: false })
	document_type: string;

	@Column({ type: 'date', nullable: false, default: () => 'CURRENT_DATE' })
	upload_date: Date;

	@Column({ type: 'text', nullable: true })
	file_url?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'company_legal_documents_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}

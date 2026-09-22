import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.rag_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): Users can view RAG documents from their holding (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX rag_documents_embedding_ivfflat_idx ON public.rag_documents USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')
 * Índice no declarado (expresión/orden/método): CREATE INDEX rag_documents_metadata_gin_idx ON public.rag_documents USING gin (metadata)
 */
@Entity('rag_documents')
@Index('rag_documents_holding_id_idx', ['holding_id'])
@Index('rag_documents_source_idx', ['source_type', 'source_id'])
export class RagDocument {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'rag_documents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	source_type: string;

	@Column({ type: 'text', nullable: true })
	source_id?: string;

	@Column({ type: 'text', nullable: false })
	content: string;

	@Column({ type: 'jsonb', nullable: false, default: '{}' })
	metadata: any;

	@Column({ type: 'vector', length: 1536, nullable: true })
	embedding?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'rag_documents_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

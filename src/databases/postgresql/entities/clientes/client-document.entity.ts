import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

/**
 * Entity de `public.client_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 8 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): holding_access_client_documents (ALL, public).
 */
@Entity('client_documents')
@Index('idx_client_documents_holding_id', ['holding_id'])
export class ClientDocument {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_documents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'text', nullable: true })
	document_name?: string;

	@Column({ type: 'text', nullable: true })
	file_url?: string;

	@Column({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	uploaded_at?: Date;

	@Column({ type: 'uuid', nullable: false, default: () => 'gen_random_uuid()' })
	holding_id: string;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_documents_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_client_documents_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

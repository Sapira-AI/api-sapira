import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

/**
 * Entity de `public.client_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 8 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): holding_access_client_documents (ALL, public).
 *
 * 24-09-2026 (`migrations/1790272076545-CreateClientActivityNotesAndDocumentStorage.ts`): columnas de Storage
 * privado para los documentos que sube el front nuevo. Esos archivos van al bucket privado `client-files` y la API
 * emite URLs firmadas; `file_url` apunta a la ruta de descarga del front nuevo (verifica sesión y holding y
 * redirige a la URL firmada), así la app actual los sigue abriendo sin cambios. Los documentos antiguos
 * (bucket público `client_documents`) quedan con `storage_path` NULL y su `file_url` público.
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

	@Column({ type: 'text', nullable: true, comment: 'Bucket de Storage (privado) del archivo; NULL en documentos antiguos con URL pública' })
	storage_bucket?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Ruta del objeto dentro del bucket: <holding_id>/<client_id>/<id>/<nombre>' })
	storage_path?: string | null;

	@Column({ type: 'bigint', nullable: true })
	file_size?: string | null;

	@Column({ type: 'text', nullable: true })
	mime_type?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'users.id de quien lo subió' })
	uploaded_by?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Razón social a la que corresponde (opcional)' })
	client_entity_id?: string | null;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Borrado lógico desde el front nuevo' })
	deleted_at?: Date | null;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_documents_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_client_documents_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'client_documents_uploaded_by_fkey' })
	uploader?: User;

	@ManyToOne(() => ClientEntity, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_documents_client_entity_id_fkey' })
	clientEntity?: ClientEntity;
}

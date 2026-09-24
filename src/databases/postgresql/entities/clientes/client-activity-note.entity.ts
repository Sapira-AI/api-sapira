import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

/**
 * Notas de la línea de tiempo (pestaña Actividad del Cliente 360, pedido de Domi 24-09-2026): registros
 * fechados con autor ("llamé a finanzas, pagan el viernes"), distintos de `clients.notes`, que es la nota fija
 * del cliente. Solo la usa la API (RLS activo sin policy para `anon`/`authenticated`). Borrado lógico
 * (`deleted_at`) para no perder la trazabilidad.
 *
 * Tabla nueva creada por `migrations/1790272076545-CreateClientActivityNotesAndDocumentStorage.ts`.
 */
@Entity('client_activity_notes')
@Index('client_activity_notes_client_idx', ['client_id', 'created_at'])
@Check('client_activity_notes_body_check', `char_length(btrim(body)) BETWEEN 1 AND 5000`)
export class ClientActivityNote {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_activity_notes_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	client_id: string;

	@Column({ type: 'text' })
	body: string;

	@Column({ type: 'uuid', nullable: true, comment: 'users.id de quien escribió la nota' })
	created_by?: string | null;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Borrado lógico: la nota deja de mostrarse pero se conserva' })
	deleted_at?: Date | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_activity_notes_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_activity_notes_client_id_fkey' })
	client?: Client;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'client_activity_notes_created_by_fkey' })
	author?: User;
}

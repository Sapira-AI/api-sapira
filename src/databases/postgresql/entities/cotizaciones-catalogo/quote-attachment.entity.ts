import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';

/**
 * Entity de `public.quote_attachments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Adjuntos de cotizaciones incluyendo aceptación de cliente, OC, HES
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): Users can delete quote attachments in their holding (DELETE, public); Users can insert quote attachments in their holding (INSERT, public); Users can update quote attachments in their holding (UPDATE, public); Users can view quote attachments in their holding (SELECT, public).
 */
@Entity({ name: 'quote_attachments', comment: 'Adjuntos de cotizaciones incluyendo aceptación de cliente, OC, HES' })
@Check(
	'quote_attachments_attachment_type_check',
	"attachment_type = ANY (ARRAY['acceptance'::text, 'purchase_order'::text, 'hes'::text, 'contract'::text, 'other'::text])"
)
@Index('idx_quote_attachments_attachment_type', ['attachment_type'])
@Index('idx_quote_attachments_holding_id', ['holding_id'])
@Index('idx_quote_attachments_quote_id', ['quote_id'])
export class QuoteAttachment {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'quote_attachments_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	quote_id: string;

	@Column({ type: 'text', nullable: false })
	file_name: string;

	@Column({ type: 'text', nullable: false })
	file_url: string;

	@Column({ type: 'text', nullable: true })
	file_type?: string;

	@Column({ type: 'integer', nullable: true })
	file_size?: number;

	/** Tipo: acceptance (aceptación cliente), purchase_order (OC), hes (HES), contract, other */
	@Column({ type: 'text', comment: 'Tipo: acceptance (aceptación cliente), purchase_order (OC), hes (HES), contract, other', nullable: false })
	attachment_type: string;

	@Column({ type: 'uuid', nullable: true })
	uploaded_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	uploaded_at?: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => Quote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'quote_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_attachments_quote_id_fkey' })
	quote?: Quote; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_attachments_uploaded_by_fkey' })
	uploadedBy?: User; // entity existente (no se duplica)
}

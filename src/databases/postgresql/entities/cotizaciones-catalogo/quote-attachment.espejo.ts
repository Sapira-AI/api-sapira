import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Quote } from '@/modules/salesforce/entities/quote.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.quote_attachments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Adjuntos de cotizaciones incluyendo aceptación de cliente, OC, HES
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): Users can delete quote attachments in their holding (DELETE, public); Users can insert quote attachments in their holding (INSERT, public); Users can update quote attachments in their holding (UPDATE, public); Users can view quote attachments in their holding (SELECT, public).
 */
@Entity('quote_attachments')
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
	@Column({ type: 'text', nullable: false })
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

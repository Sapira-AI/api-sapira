import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { User } from '@/modules/users/entities/user.entity';

import { BillingReference } from './billing-reference.espejo';

/**
 * Espejo de `public.invoice_reference_links` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): tenant_isolation_invoice_reference_links (ALL, public).
 */
@Entity('invoice_reference_links')
@Unique('invoice_reference_links_invoice_id_reference_id_key', ['invoice_id', 'reference_id'])
@Index('idx_invoice_reference_links_invoice', ['invoice_id'])
@Index('idx_invoice_reference_links_reference', ['reference_id'])
export class InvoiceReferenceLink {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_reference_links_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'uuid', nullable: false })
	reference_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	linked_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	linked_by?: string;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'linked_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_linked_by_fkey' })
	linkedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)

	@ManyToOne(() => BillingReference, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'reference_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_reference_id_fkey' })
	reference?: BillingReference;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

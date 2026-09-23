import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

import { BillingReference } from './billing-reference.entity';

/**
 * Entity de `public.invoice_reference_links` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
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

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'linked_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_linked_by_fkey' })
	linkedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => BillingReference, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'reference_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reference_links_reference_id_fkey' })
	reference?: BillingReference;
}

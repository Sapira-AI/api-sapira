import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.invoices_legacy` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 9311 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Facturas históricas o importadas desde ERP pendientes de reconciliación
 * Referenciada por FK desde 4 tabla(s): contract_invoices, invoice_items_legacy, invoices, mrr_legacy.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_auto_populate_client_tax_id · BEFORE INSERT OR UPDATE FOR EACH ROW → auto_populate_client_tax_id_from_entity().
 * Policies (4): tenant_isolation_delete_invoices_legacy (DELETE, public); tenant_isolation_insert_invoices_legacy (INSERT, public); tenant_isolation_select_invoices_legacy (SELECT, public); tenant_isolation_update_invoices_legacy (UPDATE, public).
 */
@Entity('invoices_legacy')
@Unique('invoices_legacy_holding_invoice_number_unique', ['holding_id', 'invoice_number'])
@Unique('invoices_legacy_holding_odoo_integration_key', ['holding_id', 'odoo_integration_id'])
@Check(
	'invoices_legacy_reconciliation_status_check',
	"reconciliation_status = ANY (ARRAY['pending'::text, 'partially_reconciled'::text, 'reconciled'::text, 'migrated'::text, 'mrr_legacy'::text])"
)
@Check('invoices_legacy_source_type_check', "source_type = ANY (ARRAY['historical_import'::text, 'erp_unmatched'::text, 'manual_entry'::text])")
@Check('invoices_legacy_status_check', "status = ANY (ARRAY['Enviada'::text, 'Vencida'::text, 'Pagada'::text])")
@Index('idx_invoices_legacy_client_entity_id', ['client_entity_id'])
@Index('idx_invoices_legacy_client_id', ['client_id'], { where: 'client_id IS NOT NULL' })
@Index('idx_invoices_legacy_client_tax_id', ['client_tax_id'])
@Index('idx_invoices_legacy_contract_id', ['contract_id'])
@Index('idx_invoices_legacy_holding', ['holding_id'])
@Index('idx_invoices_legacy_issue_date', ['issue_date'])
@Index('idx_invoices_legacy_odoo_integration_id', ['odoo_integration_id'])
@Index('idx_invoices_legacy_reconciliation_status', ['reconciliation_status'])
@Index('idx_invoices_legacy_status', ['status'])
export class InvoicesLegacy {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoices_legacy_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	/** ID fiscal del cliente. Puede ser NULL para integraciones donde no se tiene este dato. */
	@Column({ type: 'text', nullable: true })
	client_tax_id?: string;

	@Column({ type: 'text', nullable: false })
	legal_client_name: string;

	@Column({ type: 'text', nullable: false })
	source_type: string;

	@Column({ type: 'text', nullable: true })
	source_system?: string;

	@Column({ type: 'text', nullable: false })
	invoice_number: string;

	@Column({ type: 'date', nullable: false })
	issue_date: Date;

	@Column({ type: 'date', nullable: true })
	due_date?: Date;

	@Column({ type: 'text', nullable: false })
	invoice_currency: string;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	amount_invoice_currency: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	total_invoice_currency: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	vat?: number;

	@Column({ type: 'numeric', precision: 12, scale: 6, nullable: true })
	fx_contract_to_invoice?: number;

	/** Estado de pago: Enviada (emitida sin pago), Vencida (pasó due_date sin pago), Pagada (pagada) */
	@Column({ type: 'text', nullable: false, default: 'Enviada' })
	status: string;

	@Column({ type: 'text', nullable: true })
	pdf_url?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	/** Estado de reconciliación: pending (sin reconciliar), partially_reconciled (parcialmente reconciliada), reconciled (reconciliada completamente), migrated (migrada a invoices), mrr_legacy (usada en registro MRR Legacy) */
	@Column({ type: 'text', nullable: true, default: 'pending' })
	reconciliation_status?: string;

	@Column({ type: 'uuid', nullable: true })
	reconciled_invoice_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	reconciled_at?: Date;

	/** Referencia a la entidad legal del cliente (client_entities). El client_id se completa desde el contrato. */
	@Column({ type: 'uuid', nullable: true })
	client_entity_id?: string;

	/** ID de la factura en Odoo. Usado para mapear líneas de factura desde Odoo hacia Sapira */
	@Column({ type: 'integer', nullable: true })
	odoo_integration_id?: number;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => ClientEntity)
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_invoices_client_entity' })
	clientEntity?: ClientEntity; // entity existente (no se duplica)

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Client, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'reconciled_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_reconciled_invoice_id_fkey' })
	reconciledInvoice?: Invoice; // entity existente (no se duplica)
}

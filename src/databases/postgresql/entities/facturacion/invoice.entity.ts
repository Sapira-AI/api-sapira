import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { InvoicesLegacy } from '@/databases/postgresql/entities/legacy/invoices-legacy.entity';
import { Subscription } from '@/databases/postgresql/entities/suscripciones/subscription.entity';

@Check(
	'invoices_credit_reason_check',
	`(((credit_reason IS NULL) OR (credit_reason = ANY (ARRAY['downsell'::text, 'churn'::text, 'reschedule'::text, 'issue_error'::text, 'prompt_payment_discount'::text, 'one_time_discount'::text, 'compensation'::text, 'other'::text]))))`
)
@Check('invoices_credit_type_check', `(((credit_type IS NULL) OR (credit_type = ANY (ARRAY['cancellation'::text, 'discount'::text]))))`)
@Check(
	'invoices_document_type_check',
	`((document_type = ANY (ARRAY['FACTURA'::text, 'NC'::text, 'ND'::text, 'FACTURA_EXPORTACION'::text, 'Invoice'::text])))`
)
@Check('invoices_export_type_check', `((export_type = ANY (ARRAY[0, 1])))`)
@Check(
	'invoices_invoice_type_check',
	`((invoice_type = ANY (ARRAY['Manual'::text, 'Automatica'::text, 'Consolidada'::text, 'Importada'::text, 'Suscripción'::text, 'Unificada'::text])))`
)
@Check(
	'invoices_nc_revenue_treatment_check',
	`(((nc_revenue_treatment IS NULL) OR (nc_revenue_treatment = ANY (ARRAY['impact_month'::text, 'defer_forward'::text]))))`
)
@Check('invoices_payment_method_check', `((payment_method = ANY (ARRAY['CONTADO'::text, 'CREDITO'::text])))`)
@Check(
	'invoices_status_check',
	`((status = ANY (ARRAY['Por Emitir'::text, 'Emitida'::text, 'Enviada'::text, 'Pagada'::text, 'Vencida'::text, 'Cancelada'::text, 'Consolidada'::text, 'Dividida'::text])))`
)
@Index('idx_invoices_active_contract_period', ['contract_id', 'scheduled_at', 'is_active'], { where: `(is_active = true)` })
@Index('idx_invoices_auto_invoice', ['auto_invoice', 'status'], { where: `(auto_invoice = true)` })
@Index('idx_invoices_consolidated_into', ['consolidated_into_invoice_id'], { where: `(consolidated_into_invoice_id IS NOT NULL)` })
@Index('idx_invoices_group_id', ['invoice_group_id'], { where: `(invoice_group_id IS NOT NULL)` })
@Index('idx_invoices_holding_id', ['holding_id'])
@Index('idx_invoices_invoice_type', ['invoice_type'])
@Index('idx_invoices_odoo_invoice_id', ['odoo_invoice_id'], { where: `(odoo_invoice_id IS NOT NULL)` })
@Index('idx_invoices_overdue_check', ['due_date', 'status'], { where: `(status = ANY (ARRAY['Enviada'::text, 'Emitida'::text]))` })
@Index('idx_invoices_related_invoice_id', ['related_invoice_id'], { where: `(related_invoice_id IS NOT NULL)` })
@Index('idx_invoices_requires_references', ['requires_references_for_billing', 'status'], { where: `(requires_references_for_billing = true)` })
@Index('idx_invoices_split_from', ['split_from_invoice_id'], { where: `(split_from_invoice_id IS NOT NULL)` })
@Index('idx_invoices_stripe_id_holding_id', ['stripe_id', 'holding_id'], { where: `(stripe_id IS NOT NULL)` })
@Index('idx_invoices_subscription_id', ['subscription_id'], { where: `(subscription_id IS NOT NULL)` })
@Entity({
	name: 'invoices',
	comment: 'Tabla de facturas del sistema. \nIMPORTANTE: tax_rate se auto-completa desde companies.tax_rate en formato decimal (0.19 = 19%).',
})
export class Invoice {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'Número de factura. Se actualiza al emitir manualmente con el número real del ERP.' })
	invoice_number?: string;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de emisión real. Se actualiza al emitir manualmente.' })
	issue_date?: Date;

	@Column({ type: 'date', nullable: true })
	due_date?: Date;

	@Column({ type: 'text', nullable: true })
	contract_currency?: string;

	@Column({ type: 'text', nullable: true, comment: 'Moneda de facturación. Puede actualizarse al emitir si difiere de la programada.' })
	invoice_currency?: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	amount_contract_currency?: number;

	@Column({ type: 'numeric', nullable: true })
	amount_invoice_currency?: number;

	@Column({ type: 'numeric', nullable: true })
	vat?: number;

	@Column({ type: 'numeric', nullable: true })
	total_invoice_currency?: number;

	@Column({ type: 'numeric', nullable: true })
	amount_system_currency?: number;

	@Column({ type: 'numeric', nullable: true })
	total_system_currency?: number;

	@Column({ type: 'numeric', nullable: true, comment: 'Tipo de cambio de contrato a factura. Se actualiza con el FX real al emitir.' })
	fx_contract_to_invoice?: number;

	@Column({ type: 'text', nullable: true })
	status?: string;

	@Column({ type: 'text', nullable: true })
	pdf_url?: string;

	// En producción es nullable; `@CreateDateColumn` la declara NOT NULL por defecto.
	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({
		type: 'text',
		nullable: true,
		default: 'Automatica',
		comment:
			'Origen de la factura: Manual (creada por usuario), Automatica (generada desde contrato/modificaciones), Consolidada (resultado de consolidación), Importada (desde sistema externo)',
	})
	invoice_type?: string;

	@Column({ type: 'text', nullable: true, default: 'FAC' })
	invoice_series?: string;

	@Column({
		type: 'text',
		nullable: true,
		default: 'FACTURA',
		comment:
			'Tipo de documento fiscal: FACTURA (factura normal), NC (nota de crédito), ND (nota de débito), FACTURA_EXPORTACION (factura de exportación)',
	})
	document_type?: string;

	@Column({ type: 'text', nullable: true })
	issuer_tax_id?: string;

	@Column({ type: 'text', nullable: true })
	issuer_legal_name?: string;

	@Column({ type: 'text', nullable: true })
	issuer_address?: string;

	@Column({ type: 'uuid', nullable: true })
	client_entity_id?: string;

	@Column({ type: 'text', nullable: true })
	client_tax_id?: string;

	@Column({ type: 'text', nullable: true, default: 'CREDITO' })
	payment_method?: string;

	@Column({ type: 'text', nullable: true })
	fiscal_regime?: string;

	@Column({ type: 'integer', nullable: true, default: 0 })
	export_type?: number;

	@Column({ type: 'text', nullable: true, comment: 'Folio fiscal del documento. Se actualiza al emitir manualmente.' })
	folio_fiscal_prev?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'jsonb', nullable: true, default: () => "'[]'" })
	attachments?: object;

	@Column({ type: 'timestamp with time zone', nullable: true })
	sent_at?: Date;

	@Column({ type: 'date' })
	scheduled_at: Date;

	@Column({ type: 'date' })
	original_issue_date: Date;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	fx_contract_to_system?: number;

	@Column({ type: 'boolean', nullable: true, default: false, comment: 'Indica si la factura proviene de reconciliación legacy' })
	is_legacy?: boolean;

	@Column({ type: 'uuid', nullable: true, comment: 'Referencia a la factura legacy original' })
	legacy_invoice_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'Sistema origen (ej: Odoo, SAP, Historical Import)' })
	legacy_source_system?: string;

	@Column({ type: 'jsonb', nullable: true, default: () => "'{}'", comment: 'Campos personalizados definidos por el usuario en formato JSONB' })
	custom_fields?: object;

	@Column({ type: 'uuid', nullable: true, comment: 'Referencia a la factura original cuando este registro es una nota de crédito o débito' })
	related_invoice_id?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'ID del grupo de facturación. Facturas y sus notas de crédito comparten el mismo group_id' })
	invoice_group_id?: string;

	@Column({
		type: 'boolean',
		nullable: true,
		default: false,
		comment: 'Indica si la factura requiere OC, HES o aprobación del cliente para ser emitida. Se propaga desde contracts.',
	})
	requires_references_for_billing?: boolean;

	@Column({
		type: 'numeric',
		nullable: true,
		comment:
			'Tasa de impuesto en formato PORCENTAJE (19 para 19%, 21 para 21%).\nPoblado automáticamente desde companies.tax_rate al momento de crear la factura\nmediante el trigger auto_populate_invoice_tax_rate.\nNOTA: El estándar es PORCENTAJE, NO decimal. Usar /100 al calcular montos.\nEjemplo: tax_rate = 19 → factor = 19/100 = 0.19',
	})
	tax_rate?: number;

	@Column({
		type: 'boolean',
		default: true,
		comment: 'TRUE si la factura está activa y debe mostrarse en front/ERP. FALSE si fue consolidada en otra factura.',
	})
	is_active: boolean;

	@Column({ type: 'uuid', nullable: true, comment: 'ID de la factura consolidada que reemplaza esta factura. NULL si no ha sido consolidada.' })
	consolidated_into_invoice_id?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'ID de la factura original de la cual se dividió esta factura' })
	split_from_invoice_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'Razón de la división: partial_emission, discount, rescheduled, remaining_after_split, etc.' })
	split_reason?: string;

	@Column({
		type: 'boolean',
		nullable: true,
		default: false,
		comment: 'Indica si la factura debe facturarse automáticamente. Se propaga desde contracts.',
	})
	auto_invoice?: boolean;

	@Column({ type: 'integer', nullable: true, comment: 'ID de la factura en Odoo (retornado por la API de Odoo)' })
	odoo_invoice_id?: number;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Timestamp cuando se envió la factura a Odoo' })
	sent_to_odoo_at?: Date;

	@Column({
		type: 'uuid',
		nullable: true,
		comment: 'FK a subscriptions. Usado para invoices de suscripciones externas (Stripe, etc.). Mutuamente excluyente con contract_id.',
	})
	subscription_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'ID de la factura en Stripe (external_id)' })
	stripe_id?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'Términos y condiciones de la factura. Se propaga desde contracts.invoice_terms_and_conditions al crear la factura. Se envía a Odoo en narration.',
	})
	invoice_terms_and_conditions?: string;

	// Tres columnas que existen en producción y la entity no declaraba: una migración generada
	// las habría borrado. api-sapira no las usa; el front sí (InvoiceRelatedDocsSection,
	// invoiceAdvancedService).
	@Column({ type: 'text', nullable: true, comment: "Tipo de NC: cancellation | discount. Solo se puebla cuando document_type='NC'." })
	credit_type?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment: "Motivo de la NC: downsell | churn | reschedule | issue_error. Solo se puebla cuando document_type='NC'.",
	})
	credit_reason?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'Solo NC discount: devengo del descuento en RSM (impact_month = mes de la NC; defer_forward = meses restantes del ítem). NULL en facturas y NC de anulación/churn.',
	})
	nc_revenue_treatment?: string;

	// `holding_id` tiene DOS FKs en producción sobre la misma columna, con ON DELETE distinto:
	// `fk_invoices_holding_id` es CASCADE y `invoices_holding_id_fkey` es NO ACTION. Misma
	// anomalía que en `invoice_items`. Se replican ambas.
	//
	// Las FKs a `invoices_legacy` y `subscriptions` se declaran al final: sus espejos se
	// promovieron en el lote 1 de E4.
	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_invoices_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_holding_id_fkey' })
	holding2?: CompanyHolding;

	@ManyToOne(() => ClientEntity)
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_client_entity_id_fkey' })
	client_entity?: ClientEntity;

	@ManyToOne(() => Client)
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_client_id_fkey' })
	client?: Client;

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_company_id_fkey' })
	company?: Company;

	@ManyToOne(() => Contract)
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_contract_id_fkey' })
	contract?: Contract;

	@ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
	@JoinColumn({
		name: 'consolidated_into_invoice_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'invoices_consolidated_into_invoice_id_fkey',
	})
	consolidated_into_invoice?: Invoice;

	@ManyToOne(() => Invoice)
	@JoinColumn({ name: 'related_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_related_invoice_id_fkey' })
	related_invoice?: Invoice;

	@ManyToOne(() => Invoice, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'split_from_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_split_from_invoice_id_fkey' })
	split_from_invoice?: Invoice;

	@ManyToOne(() => InvoicesLegacy, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'legacy_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_legacy_invoice_id_fkey' })
	legacy_invoice?: InvoicesLegacy;

	@ManyToOne(() => Subscription)
	@JoinColumn({ name: 'subscription_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoices_subscription_id_fkey' })
	subscription?: Subscription;
}

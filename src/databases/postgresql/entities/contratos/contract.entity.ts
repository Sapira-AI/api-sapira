import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { ChurnReason } from '@/databases/postgresql/entities/contratos/churn-reason.entity';
import { WorkflowStep } from '@/databases/postgresql/entities/contratos/workflow-step.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';

@Check('contracts_fx_company_policy_check', `((fx_company_policy = ANY (ARRAY['fixed_period'::text, 'monthly_avg'::text])))`)
@Check('contracts_fx_invoice_policy_check', `((fx_invoice_policy = ANY (ARRAY['fixed'::text, 'spot'::text])))`)
@Check(
	'contracts_legacy_status_check',
	`((legacy_status = ANY (ARRAY['pending'::text, 'in_reconciliation'::text, 'validated'::text, 'activated'::text])))`
)
@Check(
	'contracts_status_check',
	`((status = ANY (ARRAY['En revisión'::text, 'En proceso'::text, 'Firmado'::text, 'Activo'::text, 'Cancelado'::text, 'Expirado'::text])))`
)
@Index('idx_contracts_auto_invoice', ['auto_invoice', 'status'], { where: `(auto_invoice = true)` })
@Index('idx_contracts_auto_send_to_odoo', ['auto_send_to_odoo'], { where: `(auto_send_to_odoo = true)` })
@Index('idx_contracts_booking_date', ['booking_date'])
@Index('idx_contracts_client_entity_id', ['client_entity_id'])
@Index('idx_contracts_currency', ['contract_currency'])
@Index('idx_contracts_current_step_id', ['current_step_id'])
@Index('idx_contracts_holding_id', ['holding_id'])
@Index('idx_contracts_sf_opp', ['salesforce_opportunity_id'], { where: `(salesforce_opportunity_id IS NOT NULL)` })
@Index('idx_contracts_workflow_started_at', ['workflow_started_at'])
@Index('idx_contracts_custom_fields', { synchronize: false })
@Entity('contracts')
export class Contract {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'uuid', nullable: true })
	quote_id?: string;

	@Column({ type: 'text', nullable: true })
	contract_number?: string;

	@Column({ type: 'text', nullable: true })
	type?: string;

	@Column({ type: 'text', nullable: true, default: 'En revisión' })
	status?: string;

	@Column({ type: 'numeric', nullable: true })
	total_value?: number;

	@Column({ type: 'text', nullable: true })
	legal_client_name?: string;

	@Column({ type: 'text', nullable: true })
	legal_representative_name?: string;

	@Column({ type: 'text', nullable: true })
	legal_representative_id?: string;

	@Column({ type: 'text', nullable: true })
	client_name_commercial?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	// En producción es nullable; `@CreateDateColumn` la declara NOT NULL por defecto.
	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	client_entity_id?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	from_bulk_import?: boolean;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	current_step_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	workflow_started_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	workflow_completed_at?: Date;

	@Column({ type: 'date', nullable: true, comment: 'Fecha booking (firma/activación). Se usa como ancla temporal para CMRR.' })
	booking_date?: Date;

	@Column({ type: 'date', nullable: true })
	contract_end_date?: Date;

	@Column({ type: 'uuid', nullable: true })
	renewed_from_contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	renewed_to_contract_id?: string;

	@Column({ type: 'date', nullable: true })
	churn_date?: Date;

	@Column({ type: 'text', default: 'USD' })
	contract_currency: string;

	@Column({ type: 'numeric', nullable: true })
	total_value_system_currency?: number;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	fx_rate_to_system?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicompany_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicurrency_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_references_for_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false, comment: 'Indicates if this contract requires a formal document to be generated' })
	requires_contract_document?: boolean;

	@Column({
		type: 'text',
		nullable: true,
		comment: 'Política FX para moneda de compañía: fixed_period (por periodo) o monthly_avg (promedio mensual)',
	})
	fx_company_policy?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Fecha de confirmación de política FX de compañía' })
	fx_company_confirmed_at?: Date;

	@Column({ type: 'text', nullable: true, default: 'spot', comment: 'Política FX para facturación: fixed (fijo) o spot (al momento de emitir)' })
	fx_invoice_policy?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Fecha de confirmación de política FX de facturación' })
	fx_invoice_confirmed_at?: Date;

	@Column({ type: 'text', nullable: true, comment: 'Currency of the issuing company (auto-populated from companies.currency)' })
	company_currency?: string;

	@Column({ type: 'boolean', nullable: true, default: false, comment: 'Indica si el contrato fue cargado desde datos históricos' })
	is_legacy?: boolean;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de corte para históricos (desde cuándo se usa Sapira)' })
	legacy_cutoff_date?: Date;

	@Column({ type: 'text', nullable: true, comment: 'Estado del proceso de reconciliación legacy' })
	legacy_status?: string;

	@Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 0, comment: 'Porcentaje de reconciliación completado (0-100)' })
	legacy_reconciliation_pct?: number;

	@Column({ type: 'jsonb', nullable: true, default: () => "'{}'", comment: 'Campos personalizados definidos por el usuario en formato JSONB' })
	custom_fields?: object;

	@Column({ type: 'text', nullable: true, comment: 'Razón de la cancelación del contrato (churn). Se registra cuando el contrato es cancelado.' })
	churn_reason?: string;

	@Column({
		type: 'integer',
		nullable: true,
		comment: 'Duración del contrato en meses. Se calcula automáticamente como el MAX(term_months) de los contract_items.',
	})
	term?: number;

	@Column({
		type: 'boolean',
		nullable: true,
		default: false,
		comment: 'Indica si el contrato debe facturarse automáticamente. Se propaga a las facturas generadas desde este contrato.',
	})
	auto_invoice?: boolean;

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'ID de la oportunidad en Salesforce. Usado para cruzar datos del DWH\n (BigQuery → quantities) cuando los IDs de Sapira no están disponibles.',
	})
	salesforce_opportunity_id?: string;

	@Column({
		type: 'boolean',
		default: true,
		comment:
			'Para contratos legacy: si true, agrupa contract_invoices del mismo período en una sola fila. Si false, mantiene una fila por item por período. Determina cómo create_legacy_contract_with_items y regenerate_contract_invoices_from_items generan las facturas programadas.',
	})
	group_invoices_by_period: boolean;

	@Column({
		type: 'boolean',
		default: false,
		comment:
			'Indica si las facturas de este contrato se envían automáticamente a Odoo cuando llega su issue_date. Si es false, las facturas deben enviarse manualmente.',
	})
	auto_send_to_odoo: boolean;

	@Column({ type: 'text', nullable: true, comment: 'Moneda de facturación del contrato. Define en qué moneda se emitirán las facturas.' })
	invoice_currency?: string;

	@Column({
		type: 'uuid',
		nullable: true,
		comment:
			'FK a churn_reasons. Reemplaza semánticamente a churn_reason (text). La columna churn_reason se mantiene como legacy para backfill de datos anteriores a 2026-04-19.',
	})
	churn_reason_id?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment:
			'Términos y condiciones que se incluirán en el campo narration de las facturas generadas por este contrato. Acepta HTML para formato enriquecido.',
	})
	invoice_terms_and_conditions?: string;

	@ManyToOne(() => ChurnReason)
	@JoinColumn({ name: 'churn_reason_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_churn_reason_id_fkey' })
	churn_reason_ref?: ChurnReason;

	@ManyToOne(() => WorkflowStep)
	@JoinColumn({ name: 'current_step_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_current_step_id_fkey' })
	current_step?: WorkflowStep;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contracts_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => ClientEntity)
	@JoinColumn({ name: 'client_entity_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_client_entity_id_fkey' })
	client_entity?: ClientEntity;

	@ManyToOne(() => Client)
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_client_id_fkey' })
	client?: Client;

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_company_id_fkey' })
	company?: Company;

	@ManyToOne(() => Quote)
	@JoinColumn({ name: 'quote_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_quote_id_fkey' })
	quote?: Quote;

	@ManyToOne(() => Contract)
	@JoinColumn({
		name: 'renewed_from_contract_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'contracts_renewed_from_contract_id_fkey',
	})
	renewed_from_contract?: Contract;

	@ManyToOne(() => Contract)
	@JoinColumn({ name: 'renewed_to_contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contracts_renewed_to_contract_id_fkey' })
	renewed_to_contract?: Contract;
}

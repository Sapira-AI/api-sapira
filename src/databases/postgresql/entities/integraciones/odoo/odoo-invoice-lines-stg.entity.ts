import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { OdooInvoicesStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-invoices-stg.entity';

@Unique('odoo_invoice_lines_stg_holding_id_odoo_line_id_key', ['holding_id', 'odoo_line_id'])
@Check(
	'odoo_invoice_lines_stg_processing_status_check',
	`((processing_status = ANY (ARRAY['create'::text, 'update'::text, 'processed'::text, 'error'::text])))`
)
@Index('idx_odoo_invoice_lines_stg_batch_id', ['batch_id'], { where: `(batch_id IS NOT NULL)` })
@Index('idx_odoo_invoice_lines_stg_error', ['processing_status'], { where: `(processing_status = 'error'::text)` })
@Index('idx_odoo_invoice_lines_stg_holding_status', ['holding_id', 'processing_status'])
@Index('idx_odoo_invoice_lines_stg_invoice_staging_id', ['invoice_staging_id'])
@Index('idx_odoo_invoice_lines_stg_odoo_invoice_id', ['odoo_invoice_id'])
@Index('idx_odoo_invoice_lines_stg_odoo_line_id', ['odoo_line_id'])
@Index('idx_odoo_invoice_lines_stg_processing_status', ['processing_status'])
@Index('idx_odoo_invoice_lines_stg_sync_session', ['sync_session_id'], { where: `(sync_session_id IS NOT NULL)` })
@Entity({
	name: 'odoo_invoice_lines_stg',
	comment: 'Tabla de staging para líneas de factura de Odoo (account.move.line) con relación a factura padre',
})
export class OdooInvoiceLinesStg {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'odoo_invoice_lines_stg_pkey' })
	id!: string;

	@Column({ type: 'uuid', nullable: false, comment: 'Referencia a la factura padre en staging' })
	invoice_staging_id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'integer', nullable: false, comment: 'ID de la línea en Odoo (account.move.line.id)' })
	odoo_line_id!: number;

	@Column({ type: 'integer', nullable: false, comment: 'ID de la factura padre en Odoo para referencia directa' })
	odoo_invoice_id!: number;

	@Column({ type: 'jsonb', nullable: false, comment: 'Datos completos de la línea en formato JSON desde Odoo' })
	raw_data!: any;

	// El default es 'create', no 'pending': el CHECK de esta columna solo admite
	// create | update | processed | error. Ver migración AlignStagingProcessingStatusDefault.
	@Column({ type: 'text', nullable: true, default: 'create', comment: 'Estado del procesamiento: create, update, processed, error' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true })
	integration_batch_id?: string;

	@Column({ type: 'timestamp', nullable: true })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true, comment: 'Mensaje de error detallado cuando falla el procesamiento de la línea de factura' })
	error_message?: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	updated_at!: Date;

	@Column({ type: 'uuid', nullable: true, comment: 'ID único del lote de procesamiento individual' })
	batch_id?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'ID único de la sesión de sincronización completa (compartido entre lotes)' })
	sync_session_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_invoice_lines_stg_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => OdooInvoicesStg, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'invoice_staging_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'odoo_invoice_lines_stg_invoice_staging_id_fkey',
	})
	invoiceStaging?: OdooInvoicesStg;
}

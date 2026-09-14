import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('odoo_invoices_stg_holding_id_odoo_id_key', ['holding_id', 'odoo_id'])
@Check(
	'odoo_invoices_stg_processing_status_check',
	`((processing_status = ANY (ARRAY['create'::text, 'update'::text, 'processed'::text, 'error'::text])))`
)
@Index('idx_odoo_invoices_stg_batch_id', ['integration_batch_id'])
@Index('idx_odoo_invoices_stg_error', ['processing_status'], { where: `(processing_status = 'error'::text)` })
@Index('idx_odoo_invoices_stg_holding_status', ['holding_id', 'processing_status'])
@Index('idx_odoo_invoices_stg_odoo_id_status', ['odoo_id', 'processing_status'])
@Index('idx_odoo_invoices_stg_processing_status', ['processing_status'])
@Index('idx_odoo_invoices_stg_sync_batch', ['sync_batch_id'])
@Index('idx_odoo_invoices_stg_sync_session', ['sync_session_id'], { where: `(sync_session_id IS NOT NULL)` })
@Entity({
	name: 'odoo_invoices_stg',
	comment: 'Tabla de staging para facturas de Odoo (account.move) con metadatos de procesamiento',
})
export class OdooInvoicesStg {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'odoo_invoices_stg_pkey' })
	id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'integer', nullable: false, comment: 'ID de la factura en Odoo (account.move.id)' })
	odoo_id!: number;

	@Column({ type: 'jsonb', nullable: false, comment: 'Datos completos de la factura en formato JSON desde Odoo' })
	raw_data!: any;

	@Column({ type: 'uuid', nullable: true })
	sync_batch_id?: string;

	// El default es 'create', no 'pending': el CHECK de esta columna solo admite
	// create | update | processed | error. Ver migración AlignStagingProcessingStatusDefault.
	@Column({ type: 'text', nullable: true, default: 'create', comment: 'Estado del procesamiento: create, update, processed, error' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'ID del lote de integración para agrupar facturas procesadas juntas' })
	integration_batch_id?: string;

	@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp de cuándo se integró por última vez' })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true, comment: 'Notas adicionales sobre el procesamiento (errores, cambios detectados, etc.)' })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true, comment: 'Mensaje de error detallado cuando falla el procesamiento de la factura' })
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
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_invoices_stg_holding_id_fkey' })
	holding?: CompanyHolding;
}

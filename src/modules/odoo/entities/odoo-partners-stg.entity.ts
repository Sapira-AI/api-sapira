import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Unique('odoo_partners_stg_odoo_id_holding_id_key', ['odoo_id', 'holding_id'])
@Check(
	'odoo_partners_stg_processing_status_check',
	`((processing_status = ANY (ARRAY['create'::text, 'update'::text, 'processed'::text, 'error'::text])))`
)
@Index('idx_odoo_partners_stg_batch_id', ['integration_batch_id'])
@Index('idx_odoo_partners_stg_holding_id', ['holding_id'])
@Index('idx_odoo_partners_stg_odoo_id', ['odoo_id'])
@Index('idx_odoo_partners_stg_odoo_id_status', ['odoo_id', 'processing_status'])
@Index('idx_odoo_partners_stg_processed_at', ['processed_at'])
@Index('idx_odoo_partners_stg_processing_status', ['processing_status'])
@Entity({
	name: 'odoo_partners_stg',
	comment: 'Tabla de staging para partners de Odoo con JSON híbrido',
})
export class OdooPartnersStg {
	// Producción usa bigserial (bigint + secuencia), no serial.
	@PrimaryGeneratedColumn('increment', { type: 'bigint', primaryKeyConstraintName: 'odoo_partners_stg_pkey' })
	id!: number;

	@Column({ type: 'integer', nullable: false })
	odoo_id!: number;

	@Column({ type: 'jsonb', nullable: false, comment: 'JSON completo del partner desde Odoo XML-RPC' })
	raw_data!: any;

	@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp de cuándo se procesó a la tabla final' })
	processed_at?: Date;

	@Column({ type: 'text', nullable: true, comment: 'ID del lote de sincronización para agrupar registros' })
	sync_batch_id?: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	updated_at!: Date;

	@Column({ type: 'text', nullable: true, default: 'processed', comment: 'Estado del procesamiento: pending, processed, error' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true, comment: 'ID del lote de integración para agrupar registros procesados juntos' })
	integration_batch_id?: string;

	@Column({ type: 'timestamp', nullable: true, comment: 'Timestamp de cuándo se integró por última vez' })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true, comment: 'Notas adicionales sobre el procesamiento (errores, cambios detectados, etc.)' })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true, comment: 'Mensaje de error capturado durante el procesamiento del partner' })
	error_message?: string;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_partners_stg_holding_id_fkey' })
	holding?: CompanyHolding;
}

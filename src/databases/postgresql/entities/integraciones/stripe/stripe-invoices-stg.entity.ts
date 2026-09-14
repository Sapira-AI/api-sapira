import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Unique('unique_stripe_invoice_per_holding', ['holding_id', 'stripe_id'])
@Index('idx_stripe_invoices_stg_connection_id', ['connection_id'])
@Index('idx_stripe_invoices_stg_holding_id', ['holding_id'])
@Index('idx_stripe_invoices_stg_processing_status', ['processing_status'])
@Index('idx_stripe_invoices_stg_stripe_id', ['stripe_id'])
@Index('idx_stripe_invoices_stg_sync_batch_id', ['sync_batch_id'])
@Entity({
	name: 'stripe_invoices_stg',
	comment: 'Tabla staging para facturas importadas desde Stripe',
})
export class StripeInvoicesStg {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'stripe_invoices_stg_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	stripe_id: string;

	@Column({ type: 'jsonb', nullable: false, comment: 'Datos completos de la factura en formato JSON' })
	raw_data: any;

	@Column({ type: 'uuid', nullable: true })
	sync_batch_id?: string;

	@Column({ type: 'text', nullable: true, default: 'pending' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true })
	integration_batch_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	connection_id?: string;
}

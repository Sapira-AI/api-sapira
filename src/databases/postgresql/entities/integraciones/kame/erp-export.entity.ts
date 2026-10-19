import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

export const ERP_EXPORT_SYSTEMS = ['kame'] as const;
export const ERP_EXPORT_OBJECTS = ['invoice', 'journal'] as const;
export const ERP_EXPORT_STATUSES = ['pending', 'sending', 'sent', 'error', 'simulated', 'skipped'] as const;
export type ErpExportObject = (typeof ERP_EXPORT_OBJECTS)[number];
export type ErpExportStatus = (typeof ERP_EXPORT_STATUSES)[number];

/**
 * `erp_exports` — cola e historial de lo que Sapira envía a un ERP contable (hoy Kame): una fila por factura o por mes de asientos
 * y ambiente. Es la idempotencia del envío: los índices únicos parciales impiden registrar dos veces la misma factura (o el mismo mes
 * de una compañía) en el mismo ambiente; lo enviado a la empresa de pruebas no bloquea el envío a producción.
 *
 * Genérica por `system` para no sumar columnas `kame_*` a `invoices` (Odoo sigue con `sent_to_odoo_at`/`odoo_invoice_id`). Entity +
 * migración `1792200000000-KameIntegration`; solo la API: RLS activo **sin policies**.
 */
@Entity({ name: 'erp_exports', comment: 'Cola e historial de envíos de facturas y asientos a un ERP contable (Kame). Solo la API' })
@Check('erp_exports_system_check', `system = ANY (ARRAY['kame'::text])`)
@Check('erp_exports_environment_check', `environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])`)
@Check('erp_exports_object_check', `object = ANY (ARRAY['invoice'::text, 'journal'::text])`)
@Check(
	'erp_exports_status_check',
	`status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'error'::text, 'simulated'::text, 'skipped'::text])`
)
@Check(
	'erp_exports_target_check',
	`(object = 'invoice' AND invoice_id IS NOT NULL AND period IS NULL) OR (object = 'journal' AND invoice_id IS NULL AND period IS NOT NULL)`
)
@Index('erp_exports_invoice_key', ['system', 'environment', 'invoice_id'], { unique: true, where: `(object = 'invoice'::text)` })
@Index('erp_exports_journal_key', ['system', 'environment', 'company_id', 'period'], { unique: true, where: `(object = 'journal'::text)` })
@Index('idx_erp_exports_due', ['status', 'next_attempt_at'])
@Index('idx_erp_exports_holding', ['holding_id', 'created_at'])
export class ErpExport {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'erp_exports_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid' })
	company_id!: string;

	@Column({ type: 'text', comment: 'ERP de destino: kame' })
	system!: string;

	@Column({ type: 'text', comment: 'Ambiente del ERP al que se envió: pruebas o produccion' })
	environment!: string;

	@Column({ type: 'text', comment: 'invoice (factura emitida) o journal (asientos de devengo de un mes)' })
	object!: ErpExportObject;

	@Column({ type: 'uuid', nullable: true, comment: 'Factura enviada (object = invoice)' })
	invoice_id?: string | null;

	@Column({ type: 'date', nullable: true, comment: 'Mes de los asientos, día 1 (object = journal)' })
	period?: string | null;

	@Column({ type: 'text', default: 'pending', comment: 'pending, sending, sent, error, simulated (dry run) o skipped' })
	status!: ErpExportStatus;

	@Column({ type: 'integer', default: 0, comment: 'Intentos de envío hechos' })
	attempts!: number;

	@Column({
		type: 'timestamp with time zone',
		default: () => 'now()',
		comment: 'Cuándo puede volver a intentarse (espera creciente tras un error)',
	})
	next_attempt_at!: Date;

	@Column({ type: 'text', nullable: true, comment: 'Id del registro en el ERP (IdVenta / comprobante)' })
	external_id?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Folio del registro en el ERP' })
	external_folio?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Último error (traducido para el usuario)' })
	last_error?: string | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'Cuerpo enviado (o que se enviaría, en simulación)' })
	request_payload?: unknown;

	@Column({ type: 'jsonb', nullable: true, comment: 'Respuesta del ERP' })
	response?: unknown;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Cuándo quedó registrado en el ERP' })
	sent_at?: Date | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario que lo envió a mano (null = job)' })
	requested_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'erp_exports_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'erp_exports_company_id_fkey' })
	company?: Company;

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'erp_exports_invoice_id_fkey' })
	invoice?: Invoice;
}

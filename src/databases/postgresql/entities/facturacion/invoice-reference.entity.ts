import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AuthUser } from '@/databases/postgresql/entities/auth-user.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

@Index('idx_invoice_references_holding_id', ['holding_id'])
@Index('idx_invoice_references_invoice_id', ['invoice_id'])
@Entity({
	name: 'invoice_references',
	comment:
		'Referencias cruzadas de documentos para facturacion electronica (SII DTE). Cada factura puede tener multiples referencias a OC, facturas previas, etc.',
})
export class InvoiceReference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_references_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	invoice_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'Numero o folio del documento referenciado (ej: 5020333)' })
	document_number: string;

	@Column({
		type: 'text',
		comment:
			'Codigo del tipo de documento segun SII: 801=OC, 33=Factura, 34=Factura Exenta, 56=ND, 61=NC, 802=Nota Pedido, 803=Contrato, HES=Hoja Entrada Servicio',
	})
	document_type_code: string;

	@Column({ type: 'text', nullable: true, comment: 'Nombre descriptivo del tipo de documento (ej: Orden de Compra)' })
	document_type_name?: string;

	@Column({
		type: 'text',
		nullable: true,
		comment: 'Codigo de referencia SII: 1=Anula documento ref, 2=Corrige texto, 3=Corrige monto, (vacio)=Solo referencia',
	})
	reference_code?: string;

	@Column({ type: 'text', nullable: true, comment: 'Motivo o razon de la referencia' })
	reason?: string;

	@Column({ type: 'date', nullable: true })
	reference_date?: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_references_invoice_id_fkey' })
	invoice: Invoice;

	@ManyToOne(() => AuthUser)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_references_created_by_fkey' })
	createdBy?: AuthUser;
}

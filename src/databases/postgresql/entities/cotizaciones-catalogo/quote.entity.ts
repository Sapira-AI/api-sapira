import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ClientContact } from '@/databases/postgresql/entities/clientes/client-contact.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { Seller } from '@/databases/postgresql/entities/clientes/seller.entity';
import { QuoteStage } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote-stage.entity';

@Index('idx_quotes_holding_id', ['holding_id'])
@Index('idx_quotes_quote_number', ['quote_number'])
@Index('idx_quotes_salesforce_opportunity_id', ['salesforce_opportunity_id'], { where: `(salesforce_opportunity_id IS NOT NULL)` })
@Index('idx_quotes_salesforce_opportunity_unique', ['salesforce_opportunity_id', 'holding_id'], {
	unique: true,
	where: `(salesforce_opportunity_id IS NOT NULL)`,
})
@Entity('quotes')
export class Quote {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'quotes_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	client_id: string;

	@Column({ type: 'uuid', nullable: true })
	client_contact_id: string;

	@Column({ type: 'uuid', nullable: true })
	seller_id: string;

	@Column({ type: 'date', nullable: true })
	quote_date: Date;

	@Column({ type: 'text', nullable: true })
	payment_terms: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicompany: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicurrency: boolean;

	@Column({ type: 'text', nullable: true })
	currency: string;

	@Column({ type: 'numeric', nullable: true })
	total_amount: number;

	@Column({ type: 'text', nullable: true })
	notes: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;

	@Column({ type: 'uuid' })
	quote_stage_id: string;

	@Column({ type: 'boolean', nullable: true, default: false, comment: 'Requiere OC, HES o aprobación de cliente para facturar' })
	requires_references_for_billing: boolean;

	@Column({ type: 'boolean', nullable: true, default: false, comment: 'Si requiere firma de documento de contrato con cliente' })
	requires_contract_document: boolean;

	@Column({ type: 'text', nullable: true, comment: 'ID de Oportunidad generado desde Salesforce' })
	quote_number: string;

	@Column({ type: 'text', nullable: true, comment: 'Tipo: Nuevo cliente/Upselling/Renegociación/Reactivación/NewBusiness/Downselling' })
	quote_type: string;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de aceptación del cliente (Close Date)' })
	booking_date: Date;

	@Column({ type: 'text', nullable: true })
	salesforce_opportunity_id: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_quotes_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => QuoteStage)
	@JoinColumn({ name: 'quote_stage_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_quotes_stage' })
	quoteStage?: QuoteStage;

	@ManyToOne(() => ClientContact)
	@JoinColumn({ name: 'client_contact_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quotes_client_contact_id_fkey' })
	clientContact?: ClientContact;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quotes_client_id_fkey' })
	client?: Client;

	@ManyToOne(() => Seller)
	@JoinColumn({ name: 'seller_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quotes_seller_id_fkey1' })
	seller?: Seller;
}

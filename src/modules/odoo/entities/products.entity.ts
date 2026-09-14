import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Index('idx_products_odoo_product_id', ['odoo_product_id'], { where: `(odoo_product_id IS NOT NULL)` })
@Index('idx_products_odoo_tax_ids', ['odoo_tax_ids'], { where: `(odoo_tax_ids IS NOT NULL)` })
@Index('idx_products_product_code', ['product_code'])
@Index('idx_products_salesforce_product_id', ['salesforce_product_id'])
@Index('idx_products_stripe_product_id', ['stripe_product_id'], { where: `(stripe_product_id IS NOT NULL)` })
@Entity('products')
export class Product {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'Código de producto desde Salesforce' })
	product_code?: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_recurring?: boolean;

	@Column({ type: 'text', nullable: true })
	default_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	default_price?: number;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'text', nullable: true, comment: 'ID del Producto en Salesforce' })
	salesforce_product_id?: string;

	// Campos para mapear con Odoo
	@Column({ type: 'integer', nullable: true, comment: 'ID del producto en Odoo para mapeo en facturas' })
	odoo_product_id?: number;

	@Column({ type: 'text', nullable: true, comment: 'IDs de impuestos de Odoo separados por comas (ej: "1,2,3")' })
	odoo_tax_ids?: string;

	// Campo para mapear con Stripe
	@Column({ type: 'text', nullable: true, comment: 'ID del producto en Stripe para mapeo (ej: "prod_ABC123")' })
	stripe_product_id?: string;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'products_holding_id_fkey' })
	holding?: CompanyHolding;
}

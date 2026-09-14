import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Product } from '@/modules/odoo/entities/products.entity';

@Index('idx_sf_product_map_active', ['holding_id', 'is_active'], { where: `(is_active = true)` })
@Index('idx_sf_product_map_family', ['holding_id', 'salesforce_family'], { where: `(salesforce_family IS NOT NULL)` })
@Index('idx_sf_product_map_sapira_product', ['sapira_product_id'])
@Index('idx_sf_product_map_unique', ['holding_id', 'salesforce_product_id'], { unique: true })
@Entity({
	name: 'salesforce_product_mappings',
	comment: 'Mapeo de productos Salesforce (Product2) a productos Sapira. Permite N:1 (varios productos SF → un producto Sapira)',
})
export class SalesforceProductMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_product_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'Product2.Id de Salesforce' })
	salesforce_product_id: string;

	@Column({ type: 'text', nullable: true })
	salesforce_product_name: string;

	@Column({ type: 'text', nullable: true, comment: 'Familia del producto en Salesforce (ej: Whatsapp Pro, SMS, TMS)' })
	salesforce_family: string;

	@Column({ type: 'text', nullable: true })
	salesforce_product_code: string;

	@Column({ type: 'uuid', comment: 'ID del producto en Sapira (products.id)' })
	sapira_product_id: string;

	@Column({ type: 'text', nullable: true })
	sapira_product_code: string;

	@Column({ type: 'text', nullable: true })
	sapira_product_name: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_product_mappings_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Product, { onDelete: 'RESTRICT' })
	@JoinColumn({
		name: 'sapira_product_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'salesforce_product_mappings_sapira_product_id_fkey',
	})
	sapiraProduct?: Product;
}

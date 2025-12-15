import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('products')
export class Product {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	product_code?: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_recurring?: boolean;

	@Column({ type: 'text', nullable: true })
	default_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	default_price?: number;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@Column({ type: 'text', nullable: true })
	salesforce_product_id?: string;

	// Campo para mapear con Odoo
	@Column({ type: 'integer', nullable: true })
	odoo_product_id?: number;

	// Campo para almacenar tax ID de Odoo
	@Column({ type: 'text', nullable: true })
	odoo_tax_id?: string;
}

import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Product } from '@/modules/odoo/entities/products.entity';

@Entity('odoo_product_mappings')
export class OdooProductMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column('uuid')
	holding_id: string;

	@Column('uuid')
	sapira_product_id: string;

	@Column('integer')
	odoo_product_id: number;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone' })
	updated_at: Date;

	@Column('uuid', { nullable: true })
	created_by?: string;

	@Column('jsonb', { default: {} })
	metadata: Record<string, any>;

	@ManyToOne(() => Product)
	@JoinColumn({ name: 'sapira_product_id' })
	sapira_product: Product;
}

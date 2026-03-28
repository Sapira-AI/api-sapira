import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Product } from '@/modules/odoo/entities/products.entity';

@Entity('stripe_product_mappings')
export class StripeProductMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column('uuid')
	holding_id: string;

	@Column('uuid')
	sapira_product_id: string;

	@Column('text')
	stripe_product_id: string;

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

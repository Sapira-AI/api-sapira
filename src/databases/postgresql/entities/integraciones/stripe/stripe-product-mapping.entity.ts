import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';

/** Espejo de `public.stripe_product_mappings` tal como está en producción. */
@Index('idx_stripe_mappings_holding', ['holding_id'])
@Index('idx_stripe_mappings_holding_stripe', ['holding_id', 'stripe_product_id'])
@Index('idx_stripe_mappings_sapira_product', ['sapira_product_id'])
@Index('idx_stripe_mappings_stripe_product', ['stripe_product_id'])
@Unique('unique_stripe_mapping', ['holding_id', 'sapira_product_id', 'stripe_product_id'])
@Entity({ name: 'stripe_product_mappings', comment: 'Tabla de mapeo N:N entre productos de Sapira y productos de Stripe' })
export class StripeProductMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'stripe_product_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	sapira_product_id: string;

	@Column({ type: 'text' })
	stripe_product_id: string;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@Column({
		type: 'jsonb',
		nullable: true,
		default: {},
		comment: 'Campo JSONB para almacenar información adicional del mapeo',
	})
	metadata: Record<string, any>;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'holding_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'stripe_product_mappings_holding_id_fkey',
	})
	holding?: CompanyHolding;

	@ManyToOne(() => Product, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'sapira_product_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'stripe_product_mappings_sapira_product_id_fkey',
	})
	sapira_product: Product;
}

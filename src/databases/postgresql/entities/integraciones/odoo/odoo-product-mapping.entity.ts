import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';

@Unique('unique_odoo_mapping', ['holding_id', 'sapira_product_id', 'odoo_product_id'])
@Index('idx_odoo_mappings_holding', ['holding_id'])
@Index('idx_odoo_mappings_holding_odoo', ['holding_id', 'odoo_product_id'])
@Index('idx_odoo_mappings_odoo_product', ['odoo_product_id'])
@Index('idx_odoo_mappings_sapira_product', ['sapira_product_id'])
@Entity({
	name: 'odoo_product_mappings',
	comment: 'Tabla de mapeo N:N entre productos de Sapira y productos de Odoo',
})
export class OdooProductMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'odoo_product_mappings_pkey' })
	id: string;

	@Column('uuid')
	holding_id: string;

	@Column('uuid')
	sapira_product_id: string;

	@Column('integer')
	odoo_product_id: number;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@Column('uuid', { nullable: true })
	created_by?: string;

	@Column('jsonb', { nullable: true, default: {}, comment: 'Campo JSONB para almacenar información adicional del mapeo' })
	metadata: Record<string, any>;

	@ManyToOne(() => Product, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'sapira_product_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'odoo_product_mappings_sapira_product_id_fkey',
	})
	sapira_product: Product;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'odoo_product_mappings_holding_id_fkey' })
	holding?: CompanyHolding;
}

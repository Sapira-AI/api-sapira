import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

@Index('idx_companies_odoo_integration_id', ['odoo_integration_id'])
@Index('unique_odoo_integration_id_per_holding', ['odoo_integration_id', 'holding_id'], { unique: true, where: `(odoo_integration_id IS NOT NULL)` })
@Entity('companies')
export class Company {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'text' })
	holding_name!: string;

	@Column({ type: 'text', nullable: true })
	legal_name?: string;

	@Column({ type: 'text', nullable: true })
	tax_id?: string;

	@Column({ type: 'text', nullable: true })
	country?: string;

	@Column({ type: 'text', nullable: true })
	currency?: string;

	@Column({ type: 'text', nullable: true })
	legal_address?: string;

	@Column({ type: 'text', nullable: true })
	representative_name?: string;

	@Column({ type: 'text', nullable: true })
	website?: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	phone?: string;

	@Column({ type: 'text', nullable: true })
	invoice_prefix?: string;

	@Column({ type: 'text', nullable: true })
	contract_prefix?: string;

	@Column({
		type: 'numeric',
		nullable: true,
		comment:
			'Tasa de impuesto de la empresa en formato PORCENTAJE (19 para 19%, 21 para 21%).\nEjemplos por país: Chile = 19, Perú = 18, Colombia = 19, México = 16.\nNOTA: El estándar es PORCENTAJE, NO decimal. Al crear una factura, este valor\nse copia a invoices.tax_rate mediante el trigger auto_populate_invoice_tax_rate.',
	})
	tax_rate?: number;

	@Column({ type: 'text', nullable: true })
	logo_url?: string;

	@Column({ type: 'timestamp without time zone', default: () => 'now()', nullable: true })
	created_at!: Date;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({
		type: 'integer',
		nullable: true,
		comment:
			'ID de la company correspondiente en Odoo (res.company.id). Permite mapear companies de Sapira con companies de Odoo para integración multi-empresa.',
	})
	odoo_integration_id?: number;

	@Column({
		type: 'integer',
		nullable: true,
		comment: 'ID del impuesto de venta por defecto en Odoo (account.tax). Se obtiene de account_sale_tax_id al mapear la compañía.',
	})
	odoo_default_sale_tax_id?: number;

	@Column({
		type: 'integer',
		nullable: true,
		comment: 'ID del impuesto de compra por defecto en Odoo (account.tax). Se obtiene de account_purchase_tax_id al mapear la compañía.',
	})
	odoo_default_purchase_tax_id?: number;

	@Column({ type: 'integer', nullable: true, comment: 'ID del tax de ReteICA configurado en Odoo para esta compañía (Colombia)' })
	odoo_reteica_tax_id?: number;

	@Column({ type: 'integer', nullable: true, comment: 'ID del tax de Retefuente configurado en Odoo para esta compañía (Colombia)' })
	odoo_retefuente_tax_id?: number;

	@Column({ type: 'integer', nullable: true, comment: 'ID del tax de ReteIVA configurado en Odoo para esta compañía (Colombia)' })
	odoo_reteiva_tax_id?: number;

	@ManyToOne(() => CompanyHolding, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'companies_holding_fk' })
	holding?: CompanyHolding;
}

import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';

@Check('chk_quote_items_price_entry_mode', `((price_entry_mode = ANY (ARRAY['monthly'::text, 'annual'::text])))`)
@Check(
	'quote_items_billing_frequency_check',
	`((billing_frequency = ANY (ARRAY['Mensual'::text, 'Anual'::text, 'Semestral'::text, 'Trimestral'::text, 'Bianual'::text])))`
)
@Check('quote_items_billing_method_check', `((billing_method = ANY (ARRAY['Anticipado'::text, 'Vencido'::text])))`)
@Check('quote_items_discount_type_check', `((discount_type = ANY (ARRAY['Monto fijo'::text, 'Porcentaje'::text])))`)
@Index('idx_quote_items_holding_id', ['holding_id'])
@Index('idx_quote_items_quote_item_number', ['quote_item_number'], { where: `(quote_item_number IS NOT NULL)` })
@Index('idx_quote_items_quote_item_number_unique', ['quote_item_number'], { unique: true, where: `(quote_item_number IS NOT NULL)` })
@Index('idx_quote_items_salesforce_line_item_id', ['salesforce_line_item_id'], { where: `(salesforce_line_item_id IS NOT NULL)` })
@Index('idx_quote_items_salesforce_line_item_unique', ['salesforce_line_item_id'], { unique: true, where: `(salesforce_line_item_id IS NOT NULL)` })
@Index('idx_quote_items_sf_product', ['salesforce_product_id'], { where: `(salesforce_product_id IS NOT NULL)` })
@Entity('quote_items')
export class QuoteItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'quote_items_pkey' })
	id: string;

	// Anomalía de producción: un INSERT que omita la columna genera un UUID aleatorio
	// que siempre viola la FK. Se replica tal cual.
	@Column({ type: 'uuid', nullable: true })
	quote_id: string;

	@Column({ type: 'uuid', nullable: true })
	product_id: string;

	@Column({ type: 'text' })
	product_name: string;

	@Column({ type: 'integer', nullable: true })
	term_months: number;

	@Column({ type: 'text', nullable: true })
	currency: string;

	@Column({
		type: 'numeric',
		nullable: true,
		comment: 'Precio total bruto antes de descuentos (puede ser calculado: unit_price * quantity * term_months)',
	})
	price: number;

	@Column({ type: 'text', nullable: true })
	discount_type: string;

	@Column({ type: 'numeric', nullable: true })
	discount_value: number;

	@Column({ type: 'numeric', nullable: true, comment: 'Precio total neto después de aplicar descuentos' })
	final_price: number;

	@Column({ type: 'text', nullable: true })
	billing_method: string;

	@Column({ type: 'text', nullable: true })
	billing_frequency: string;

	@Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
	holding_id: string;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de inicio del item' })
	start_date: Date;

	@Column({ type: 'date', nullable: true, comment: 'Fecha de fin del item' })
	end_date: Date;

	@Column({ type: 'boolean', default: true, comment: 'Indica si el item es recurrente' })
	is_recurring: boolean;

	@Column({ type: 'varchar', length: 64, nullable: true, comment: 'Tipo de item : Fijo, Variable, Licencias, Servicios, Hardware, etc.' })
	item_type: string;

	@Column({ type: 'varchar', length: 32, nullable: true, comment: 'Unidad de medida: USUARIOS, HORAS, PERIODOS, MESES, DÍAS, UND' })
	unit_of_measure: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, comment: 'Precio unitario final por unidad de medida' })
	unit_price: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true, comment: 'Cantidad de unidades' })
	quantity: number;

	@Column({ type: 'varchar', length: 128, nullable: true, comment: 'Cuenta contable asociada al item' })
	account: string;

	@Column({
		type: 'jsonb',
		nullable: true,
		default: {},
		comment:
			'Campos personalizados en formato JSON. Incluye: fuente_de_unidad, tipo_de_agregacion, fuente_optimizaciones, price_list_type, min_quantity, cutoff_date',
	})
	custom_fields: any;

	@Column({ type: 'text', nullable: true, comment: 'Número de línea del item (renombrado desde salesforce_line_item_id)' })
	quote_item_number: string;

	@Column({ type: 'text', nullable: true, comment: 'Fuente de datos del item' })
	data_source: string;

	@Column({ type: 'text', nullable: true, comment: 'Product2.Id original de Salesforce para tracking y debugging' })
	salesforce_product_id: string;

	@Column({ type: 'text', nullable: true })
	salesforce_line_item_id: string;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 2,
		nullable: true,
		comment: 'Precio mensual del item (final_price para recurrentes). INCLUYE descuentos aplicados.',
	})
	monthly_price: number;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 2,
		nullable: true,
		comment:
			'Precio por periodo de facturación. Para recurrentes: monthly_price × frequency_multiplier. Para one-times: (final_price/term_months) × frequency_multiplier.',
	})
	billing_period_price: number;

	@Column({ type: 'boolean', default: false, comment: 'Indica si este item debe renovarse automáticamente al vencer' })
	auto_renew: boolean;

	@Column({
		type: 'integer',
		nullable: true,
		comment: 'Término en meses para la renovación automática. Si es NULL, usa el mismo term_months del item original',
	})
	auto_renew_term_months: number;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 6,
		nullable: true,
		comment: 'Precio unitario anual. Fuente de verdad cuando price_entry_mode = annual. Derivado (unit_price * 12) cuando mode = monthly.',
	})
	annual_unit_price: number;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 2,
		nullable: true,
		comment: 'Subtotal anual = annual_unit_price * quantity. Usado para totales anuales sin redondeo.',
	})
	annual_price: number;

	@Column({
		type: 'text',
		nullable: true,
		default: 'monthly',
		comment: 'Indica cual campo es fuente de verdad: monthly (unit_price) o annual (annual_unit_price). Default: monthly.',
	})
	price_entry_mode: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_quote_items_holding_id' })
	holding?: CompanyHolding;

	@ManyToOne(() => Product)
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_items_product_id_fkey' })
	product?: Product;

	@ManyToOne(() => Quote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'quote_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_items_quote_id_fkey' })
	quote?: Quote;
}

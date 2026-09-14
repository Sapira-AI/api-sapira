import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Espejo de `public.exchange_rates` tal como está en producción.
 *
 * `idx_exchange_rates_lookup` ordena `rate_date DESC` y no se puede declarar con
 * `@Index`: vive en `special-index/`.
 */
@Index('idx_exchange_rates_currencies', ['from_currency', 'to_currency'])
@Index('idx_exchange_rates_date', ['rate_date'])
@Index('idx_exchange_rates_pair_date', ['from_currency', 'to_currency', 'rate_date'])
@Entity({
	name: 'exchange_rates',
	comment:
		'Tipos de cambio diarios. Los promedios mensuales se calculan mediante el servicio ExchangeRatesService del backend, no por triggers automáticos.',
})
export class ExchangeRateEntity {
	@PrimaryColumn({ type: 'date', primaryKeyConstraintName: 'exchange_rates_pkey' })
	rate_date: Date;

	@PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'exchange_rates_pkey' })
	from_currency: string;

	@PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'exchange_rates_pkey' })
	to_currency: string;

	@Column({ type: 'numeric', precision: 20, scale: 8 })
	rate: number;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'text', default: 'system' })
	source_type: string;

	@Column({
		type: 'text',
		nullable: true,
		default: 'system',
		comment: 'Fuente de la tasa: manual, exchangerate-api, mindicador, system',
	})
	api_source?: string;

	@Column({
		type: 'boolean',
		nullable: true,
		default: false,
		comment: 'Indica si la conversión es indirecta (ej: UF->CLP->USD)',
	})
	is_indirect_conversion: boolean;

	@Column({
		type: 'jsonb',
		nullable: true,
		comment: 'Detalles de la cadena de conversión para tasas indirectas',
	})
	conversion_chain?: Record<string, any>;
}

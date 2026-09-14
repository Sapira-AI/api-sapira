import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Espejo de `public.exchange_rates_monthly_avg` tal como está en producción. */
@Index('idx_exchange_rates_monthly_avg_currencies', ['from_currency', 'to_currency'])
@Index('idx_exchange_rates_monthly_avg_period', ['year', 'month'])
@Unique('exchange_rates_monthly_avg_from_currency_to_currency_year_m_key', ['from_currency', 'to_currency', 'year', 'month'])
@Entity({
	name: 'exchange_rates_monthly_avg',
	comment: 'Promedios mensuales de tipos de cambio calculados por el servicio ExchangeRatesService.',
})
export class ExchangeRateMonthlyAvgEntity {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'exchange_rates_monthly_avg_pkey' })
	id: string;

	@Column({ type: 'text' })
	from_currency: string;

	@Column({ type: 'text' })
	to_currency: string;

	@Column({ type: 'integer' })
	year: number;

	@Column({ type: 'integer' })
	month: number;

	// Producción no fija precisión en estas tres columnas: son `numeric` a secas.
	@Column({ type: 'numeric' })
	avg_rate: number;

	@Column({ type: 'numeric', nullable: true })
	min_rate: number;

	@Column({ type: 'numeric', nullable: true })
	max_rate: number;

	@Column({ type: 'integer', nullable: true })
	data_points: number;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	calculated_at: Date;
}

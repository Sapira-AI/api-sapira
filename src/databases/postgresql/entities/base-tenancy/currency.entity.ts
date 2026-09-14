import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Index('idx_currencies_is_active', ['is_active'])
@Index('idx_currencies_odoo_id', ['odoo_currency_id'])
@Entity('currencies')
export class Currency {
	@PrimaryColumn({ type: 'varchar', length: 3 })
	code: string;

	@Column({ type: 'varchar', length: 100 })
	name: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	name_es?: string;

	@Column({ type: 'varchar', length: 10, nullable: true })
	symbol?: string;

	@Column({ type: 'integer', nullable: true, default: 2 })
	decimal_places: number;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active: boolean;

	@Column({ type: 'integer', nullable: true })
	odoo_currency_id?: number;

	@Column({ type: 'varchar', length: 50, nullable: true })
	country?: string;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;
}

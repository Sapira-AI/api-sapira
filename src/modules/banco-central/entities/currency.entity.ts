import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

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

	@Column({ type: 'integer', default: 2 })
	decimal_places: number;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'integer', nullable: true })
	odoo_currency_id?: number;

	@Column({ type: 'varchar', length: 50, nullable: true })
	country?: string;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone' })
	updated_at: Date;
}

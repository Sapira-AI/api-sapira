import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Espejo de `public.generic_export_vats` tal como está en producción.
 *
 * La versión anterior de esta entity declaraba 7 columnas que no existen en la tabla
 * (`holding_id`, `tax_id`, `company_name`, `address`, `country`, `vat_rate`, `metadata`).
 * No rompía nada porque `GenericVatsService` consulta con `select: ['vat']`, así que
 * esas columnas nunca llegaban a un SELECT.
 */
@Unique('generic_export_vats_vat_key', ['vat'])
@Index('idx_generic_export_vats_is_active', ['is_active'])
@Index('idx_generic_export_vats_vat', ['vat'])
@Entity({
	name: 'generic_export_vats',
	comment:
		'VATs genéricos utilizados para facturación de exportación. Estos VATs se usan para múltiples clientes y NO deben usarse como identificador único.',
})
export class GenericExportVat {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'generic_export_vats_pkey' })
	id: string;

	@Column({ type: 'varchar', length: 50, comment: 'VAT genérico (RUT/Tax ID)' })
	vat: string;

	@Column({ type: 'text', nullable: true, comment: 'Descripción del VAT genérico' })
	description?: string;

	@Column({ type: 'varchar', length: 3, nullable: true, comment: 'Código ISO 3166-1 alpha-3 del país' })
	country_code?: string;

	@Column({
		type: 'boolean',
		default: true,
		comment: 'Indica si el VAT está activo (permite deshabilitar sin eliminar)',
	})
	is_active: boolean;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	updated_at: Date;
}

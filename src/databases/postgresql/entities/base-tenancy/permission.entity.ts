import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Mapea el catálogo global `public.permissions`.
 *
 * Promovida a runtime tras validar la metadata contra el snapshot productivo.
 * Las policies RLS continúan gestionadas por los assets SQL de PostgreSQL.
 */
@Entity('permissions')
@Unique('permissions_code_key', ['code'])
export class Permission {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'permissions_pkey' })
	id: string;

	@Column({ type: 'text', nullable: false })
	code: string;

	@Column({ type: 'text', nullable: true })
	description?: string;
}

import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `auth.users` de Supabase — **tabla ajena, no la gestionamos**.
 *
 * Existe solo para poder declarar las FKs que 11 tablas de `public` tienen contra
 * ella (`created_by`, `uploaded_by`, `reconciled_by`, `user_id`…). Sin esta entity
 * esas 11 constraints aparecen como diferencia permanente en `schema:log` y una
 * migración generada intentaría borrarlas.
 *
 * `synchronize: false` es la parte importante: TypeORM la ignora al comparar el
 * esquema, así que **nunca** emitirá DDL sobre `auth.users` aunque acá se declaren
 * solo dos de sus columnas. Sin esa opción, intentaría borrar el resto.
 */
@Entity({ schema: 'auth', name: 'users', synchronize: false })
export class AuthUser {
	@PrimaryColumn({ type: 'uuid' })
	id: string;

	@Column({ type: 'text', nullable: true })
	email?: string;
}

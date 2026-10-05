import { Check, Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Países ISO 3166-1 alfa-2 (catálogo global, D16 de Configuración v2). Migración M7 `1790780000000-CountriesAndCompanyCountryCode`
 * (crea la tabla, la siembra con 249 códigos y hace el backfill de `companies.country_code`). RLS activo sin policies: solo la lee la API.
 */
@Entity({ name: 'countries', comment: 'Países ISO 3166-1 alfa-2 (catálogo global; nombre en español e inglés). Lo lee la API' })
@Check('countries_code_check', `"code" ~ '^[A-Z]{2}$'`)
export class Country {
	@PrimaryColumn({ type: 'character', length: 2, primaryKeyConstraintName: 'countries_pkey' })
	code!: string;

	@Column({ type: 'text', nullable: false })
	name_es!: string;

	@Column({ type: 'text', nullable: false })
	name_en!: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at!: Date;
}

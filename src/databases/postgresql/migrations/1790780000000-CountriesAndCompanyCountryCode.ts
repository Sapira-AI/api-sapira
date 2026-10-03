import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M7 · Configuración v2 (D16): catálogo global de **países** y `companies.country_code`.
 *
 * 1. Tabla `countries` (entity `entities/base-tenancy/country.entity.ts`): ISO 3166-1 alfa-2 completa (249 códigos) con nombre en
 *    español y en inglés (nombres CLDR, los mismos que muestra `Intl.DisplayNames`). Global (sin `holding_id`), solo la lee la API
 *    (`GET /catalog/countries`): RLS activo y **sin policies** (deny-all para `anon`/`authenticated`, la API usa un rol con BYPASSRLS).
 * 2. `companies.country_code char(2)` nullable con FK a `countries(code)` (`ON DELETE RESTRICT`). La API nueva escribe el código **y**
 *    sigue escribiendo `companies.country` con el nombre en español (el front actual lee el texto).
 * 3. Backfill desde `companies.country` (texto libre): se compara sin tildes ni mayúsculas contra el nombre en español, en inglés, el
 *    código y unos alias (EE. UU., USA, UK…). Producción al 02-10: Chile, México/Mexico, Perú/Peru, Argentina, Australia, Estados Unidos,
 *    Brasil, Uruguay, Colombia → **todas calzan**. Las que no calcen quedan con `country_code NULL` y se listan en el log de la migración.
 *    `companies.country` no se toca (corregir "Mexico"/"Peru" es otra decisión, D16).
 *
 * **NO APLICADA** al 02-10.
 */
const COUNTRIES: readonly [code: string, nameEs: string, nameEn: string][] = [
	['AD', 'Andorra', 'Andorra'],
	['AE', 'Emiratos Árabes Unidos', 'United Arab Emirates'],
	['AF', 'Afganistán', 'Afghanistan'],
	['AG', 'Antigua y Barbuda', 'Antigua & Barbuda'],
	['AI', 'Anguila', 'Anguilla'],
	['AL', 'Albania', 'Albania'],
	['AM', 'Armenia', 'Armenia'],
	['AO', 'Angola', 'Angola'],
	['AQ', 'Antártida', 'Antarctica'],
	['AR', 'Argentina', 'Argentina'],
	['AS', 'Samoa Americana', 'American Samoa'],
	['AT', 'Austria', 'Austria'],
	['AU', 'Australia', 'Australia'],
	['AW', 'Aruba', 'Aruba'],
	['AX', 'Islas Aland', 'Åland Islands'],
	['AZ', 'Azerbaiyán', 'Azerbaijan'],
	['BA', 'Bosnia y Herzegovina', 'Bosnia & Herzegovina'],
	['BB', 'Barbados', 'Barbados'],
	['BD', 'Bangladés', 'Bangladesh'],
	['BE', 'Bélgica', 'Belgium'],
	['BF', 'Burkina Faso', 'Burkina Faso'],
	['BG', 'Bulgaria', 'Bulgaria'],
	['BH', 'Baréin', 'Bahrain'],
	['BI', 'Burundi', 'Burundi'],
	['BJ', 'Benín', 'Benin'],
	['BL', 'San Bartolomé', 'St. Barthélemy'],
	['BM', 'Bermudas', 'Bermuda'],
	['BN', 'Brunéi', 'Brunei'],
	['BO', 'Bolivia', 'Bolivia'],
	['BQ', 'Caribe neerlandés', 'Caribbean Netherlands'],
	['BR', 'Brasil', 'Brazil'],
	['BS', 'Bahamas', 'Bahamas'],
	['BT', 'Bután', 'Bhutan'],
	['BV', 'Isla Bouvet', 'Bouvet Island'],
	['BW', 'Botsuana', 'Botswana'],
	['BY', 'Bielorrusia', 'Belarus'],
	['BZ', 'Belice', 'Belize'],
	['CA', 'Canadá', 'Canada'],
	['CC', 'Islas Cocos', 'Cocos (Keeling) Islands'],
	['CD', 'República Democrática del Congo', 'Congo - Kinshasa'],
	['CF', 'República Centroafricana', 'Central African Republic'],
	['CG', 'Congo', 'Congo - Brazzaville'],
	['CH', 'Suiza', 'Switzerland'],
	['CI', 'Côte d’Ivoire', 'Côte d’Ivoire'],
	['CK', 'Islas Cook', 'Cook Islands'],
	['CL', 'Chile', 'Chile'],
	['CM', 'Camerún', 'Cameroon'],
	['CN', 'China', 'China'],
	['CO', 'Colombia', 'Colombia'],
	['CR', 'Costa Rica', 'Costa Rica'],
	['CU', 'Cuba', 'Cuba'],
	['CV', 'Cabo Verde', 'Cape Verde'],
	['CW', 'Curazao', 'Curaçao'],
	['CX', 'Isla de Navidad', 'Christmas Island'],
	['CY', 'Chipre', 'Cyprus'],
	['CZ', 'Chequia', 'Czechia'],
	['DE', 'Alemania', 'Germany'],
	['DJ', 'Yibuti', 'Djibouti'],
	['DK', 'Dinamarca', 'Denmark'],
	['DM', 'Dominica', 'Dominica'],
	['DO', 'República Dominicana', 'Dominican Republic'],
	['DZ', 'Argelia', 'Algeria'],
	['EC', 'Ecuador', 'Ecuador'],
	['EE', 'Estonia', 'Estonia'],
	['EG', 'Egipto', 'Egypt'],
	['EH', 'Sáhara Occidental', 'Western Sahara'],
	['ER', 'Eritrea', 'Eritrea'],
	['ES', 'España', 'Spain'],
	['ET', 'Etiopía', 'Ethiopia'],
	['FI', 'Finlandia', 'Finland'],
	['FJ', 'Fiyi', 'Fiji'],
	['FK', 'Islas Malvinas', 'Falkland Islands'],
	['FM', 'Micronesia', 'Micronesia'],
	['FO', 'Islas Feroe', 'Faroe Islands'],
	['FR', 'Francia', 'France'],
	['GA', 'Gabón', 'Gabon'],
	['GB', 'Reino Unido', 'United Kingdom'],
	['GD', 'Granada', 'Grenada'],
	['GE', 'Georgia', 'Georgia'],
	['GF', 'Guayana Francesa', 'French Guiana'],
	['GG', 'Guernesey', 'Guernsey'],
	['GH', 'Ghana', 'Ghana'],
	['GI', 'Gibraltar', 'Gibraltar'],
	['GL', 'Groenlandia', 'Greenland'],
	['GM', 'Gambia', 'Gambia'],
	['GN', 'Guinea', 'Guinea'],
	['GP', 'Guadalupe', 'Guadeloupe'],
	['GQ', 'Guinea Ecuatorial', 'Equatorial Guinea'],
	['GR', 'Grecia', 'Greece'],
	['GS', 'Islas Georgia del Sur y Sandwich del Sur', 'South Georgia & South Sandwich Islands'],
	['GT', 'Guatemala', 'Guatemala'],
	['GU', 'Guam', 'Guam'],
	['GW', 'Guinea-Bisáu', 'Guinea-Bissau'],
	['GY', 'Guyana', 'Guyana'],
	['HK', 'RAE de Hong Kong (China)', 'Hong Kong SAR China'],
	['HM', 'Islas Heard y McDonald', 'Heard & McDonald Islands'],
	['HN', 'Honduras', 'Honduras'],
	['HR', 'Croacia', 'Croatia'],
	['HT', 'Haití', 'Haiti'],
	['HU', 'Hungría', 'Hungary'],
	['ID', 'Indonesia', 'Indonesia'],
	['IE', 'Irlanda', 'Ireland'],
	['IL', 'Israel', 'Israel'],
	['IM', 'Isla de Man', 'Isle of Man'],
	['IN', 'India', 'India'],
	['IO', 'Territorio Británico del Océano Índico', 'British Indian Ocean Territory'],
	['IQ', 'Irak', 'Iraq'],
	['IR', 'Irán', 'Iran'],
	['IS', 'Islandia', 'Iceland'],
	['IT', 'Italia', 'Italy'],
	['JE', 'Jersey', 'Jersey'],
	['JM', 'Jamaica', 'Jamaica'],
	['JO', 'Jordania', 'Jordan'],
	['JP', 'Japón', 'Japan'],
	['KE', 'Kenia', 'Kenya'],
	['KG', 'Kirguistán', 'Kyrgyzstan'],
	['KH', 'Camboya', 'Cambodia'],
	['KI', 'Kiribati', 'Kiribati'],
	['KM', 'Comoras', 'Comoros'],
	['KN', 'San Cristóbal y Nieves', 'St. Kitts & Nevis'],
	['KP', 'Corea del Norte', 'North Korea'],
	['KR', 'Corea del Sur', 'South Korea'],
	['KW', 'Kuwait', 'Kuwait'],
	['KY', 'Islas Caimán', 'Cayman Islands'],
	['KZ', 'Kazajistán', 'Kazakhstan'],
	['LA', 'Laos', 'Laos'],
	['LB', 'Líbano', 'Lebanon'],
	['LC', 'Santa Lucía', 'St. Lucia'],
	['LI', 'Liechtenstein', 'Liechtenstein'],
	['LK', 'Sri Lanka', 'Sri Lanka'],
	['LR', 'Liberia', 'Liberia'],
	['LS', 'Lesoto', 'Lesotho'],
	['LT', 'Lituania', 'Lithuania'],
	['LU', 'Luxemburgo', 'Luxembourg'],
	['LV', 'Letonia', 'Latvia'],
	['LY', 'Libia', 'Libya'],
	['MA', 'Marruecos', 'Morocco'],
	['MC', 'Mónaco', 'Monaco'],
	['MD', 'Moldavia', 'Moldova'],
	['ME', 'Montenegro', 'Montenegro'],
	['MF', 'San Martín', 'St. Martin'],
	['MG', 'Madagascar', 'Madagascar'],
	['MH', 'Islas Marshall', 'Marshall Islands'],
	['MK', 'Macedonia del Norte', 'North Macedonia'],
	['ML', 'Mali', 'Mali'],
	['MM', 'Myanmar (Birmania)', 'Myanmar (Burma)'],
	['MN', 'Mongolia', 'Mongolia'],
	['MO', 'RAE de Macao (China)', 'Macao SAR China'],
	['MP', 'Islas Marianas del Norte', 'Northern Mariana Islands'],
	['MQ', 'Martinica', 'Martinique'],
	['MR', 'Mauritania', 'Mauritania'],
	['MS', 'Montserrat', 'Montserrat'],
	['MT', 'Malta', 'Malta'],
	['MU', 'Mauricio', 'Mauritius'],
	['MV', 'Maldivas', 'Maldives'],
	['MW', 'Malaui', 'Malawi'],
	['MX', 'México', 'Mexico'],
	['MY', 'Malasia', 'Malaysia'],
	['MZ', 'Mozambique', 'Mozambique'],
	['NA', 'Namibia', 'Namibia'],
	['NC', 'Nueva Caledonia', 'New Caledonia'],
	['NE', 'Níger', 'Niger'],
	['NF', 'Isla Norfolk', 'Norfolk Island'],
	['NG', 'Nigeria', 'Nigeria'],
	['NI', 'Nicaragua', 'Nicaragua'],
	['NL', 'Países Bajos', 'Netherlands'],
	['NO', 'Noruega', 'Norway'],
	['NP', 'Nepal', 'Nepal'],
	['NR', 'Nauru', 'Nauru'],
	['NU', 'Niue', 'Niue'],
	['NZ', 'Nueva Zelanda', 'New Zealand'],
	['OM', 'Omán', 'Oman'],
	['PA', 'Panamá', 'Panama'],
	['PE', 'Perú', 'Peru'],
	['PF', 'Polinesia Francesa', 'French Polynesia'],
	['PG', 'Papúa Nueva Guinea', 'Papua New Guinea'],
	['PH', 'Filipinas', 'Philippines'],
	['PK', 'Pakistán', 'Pakistan'],
	['PL', 'Polonia', 'Poland'],
	['PM', 'San Pedro y Miquelón', 'St. Pierre & Miquelon'],
	['PN', 'Islas Pitcairn', 'Pitcairn Islands'],
	['PR', 'Puerto Rico', 'Puerto Rico'],
	['PS', 'Territorios Palestinos', 'Palestinian Territories'],
	['PT', 'Portugal', 'Portugal'],
	['PW', 'Palaos', 'Palau'],
	['PY', 'Paraguay', 'Paraguay'],
	['QA', 'Catar', 'Qatar'],
	['RE', 'Reunión', 'Réunion'],
	['RO', 'Rumanía', 'Romania'],
	['RS', 'Serbia', 'Serbia'],
	['RU', 'Rusia', 'Russia'],
	['RW', 'Ruanda', 'Rwanda'],
	['SA', 'Arabia Saudí', 'Saudi Arabia'],
	['SB', 'Islas Salomón', 'Solomon Islands'],
	['SC', 'Seychelles', 'Seychelles'],
	['SD', 'Sudán', 'Sudan'],
	['SE', 'Suecia', 'Sweden'],
	['SG', 'Singapur', 'Singapore'],
	['SH', 'Santa Elena', 'St. Helena'],
	['SI', 'Eslovenia', 'Slovenia'],
	['SJ', 'Svalbard y Jan Mayen', 'Svalbard & Jan Mayen'],
	['SK', 'Eslovaquia', 'Slovakia'],
	['SL', 'Sierra Leona', 'Sierra Leone'],
	['SM', 'San Marino', 'San Marino'],
	['SN', 'Senegal', 'Senegal'],
	['SO', 'Somalia', 'Somalia'],
	['SR', 'Surinam', 'Suriname'],
	['SS', 'Sudán del Sur', 'South Sudan'],
	['ST', 'Santo Tomé y Príncipe', 'São Tomé & Príncipe'],
	['SV', 'El Salvador', 'El Salvador'],
	['SX', 'Sint Maarten', 'Sint Maarten'],
	['SY', 'Siria', 'Syria'],
	['SZ', 'Esuatini', 'Eswatini'],
	['TC', 'Islas Turcas y Caicos', 'Turks & Caicos Islands'],
	['TD', 'Chad', 'Chad'],
	['TF', 'Territorios Australes Franceses', 'French Southern Territories'],
	['TG', 'Togo', 'Togo'],
	['TH', 'Tailandia', 'Thailand'],
	['TJ', 'Tayikistán', 'Tajikistan'],
	['TK', 'Tokelau', 'Tokelau'],
	['TL', 'Timor-Leste', 'Timor-Leste'],
	['TM', 'Turkmenistán', 'Turkmenistan'],
	['TN', 'Túnez', 'Tunisia'],
	['TO', 'Tonga', 'Tonga'],
	['TR', 'Turquía', 'Türkiye'],
	['TT', 'Trinidad y Tobago', 'Trinidad & Tobago'],
	['TV', 'Tuvalu', 'Tuvalu'],
	['TW', 'Taiwán', 'Taiwan'],
	['TZ', 'Tanzania', 'Tanzania'],
	['UA', 'Ucrania', 'Ukraine'],
	['UG', 'Uganda', 'Uganda'],
	['UM', 'Islas menores alejadas de EE. UU.', 'U.S. Outlying Islands'],
	['US', 'Estados Unidos', 'United States'],
	['UY', 'Uruguay', 'Uruguay'],
	['UZ', 'Uzbekistán', 'Uzbekistan'],
	['VA', 'Ciudad del Vaticano', 'Vatican City'],
	['VC', 'San Vicente y las Granadinas', 'St. Vincent & Grenadines'],
	['VE', 'Venezuela', 'Venezuela'],
	['VG', 'Islas Vírgenes Británicas', 'British Virgin Islands'],
	['VI', 'Islas Vírgenes de EE. UU.', 'U.S. Virgin Islands'],
	['VN', 'Vietnam', 'Vietnam'],
	['VU', 'Vanuatu', 'Vanuatu'],
	['WF', 'Wallis y Futuna', 'Wallis & Futuna'],
	['WS', 'Samoa', 'Samoa'],
	['YE', 'Yemen', 'Yemen'],
	['YT', 'Mayotte', 'Mayotte'],
	['ZA', 'Sudáfrica', 'South Africa'],
	['ZM', 'Zambia', 'Zambia'],
	['ZW', 'Zimbabue', 'Zimbabwe'],
];

/** Alias frecuentes en texto libre → código. Se comparan normalizados (sin tildes, minúsculas, sin puntos). */
const COUNTRY_ALIASES: readonly [alias: string, code: string][] = [
	['eeuu', 'US'],
	['ee uu', 'US'],
	['usa', 'US'],
	['estados unidos de america', 'US'],
	['united states of america', 'US'],
	['uk', 'GB'],
	['inglaterra', 'GB'],
	['england', 'GB'],
	['espana', 'ES'],
	['corea', 'KR'],
	['republica dominicana', 'DO'],
];

/** Normalización SQL: sin tildes, minúsculas, sin puntos y espacios simples. */
const NORMALIZE = (expression: string) =>
	`btrim(regexp_replace(lower(translate(${expression}, 'ÁÉÍÓÚÜÑÇÂÊÔÃÕáéíóúüñçâêôãõ.', 'AEIOUUNCAEOAOaeiouuncaeoao ')), '\\s+', ' ', 'g'))`;

export class CountriesAndCompanyCountryCode1790780000000 implements MigrationInterface {
	name = 'CountriesAndCompanyCountryCode1790780000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. Catálogo
		await queryRunner.query(
			`CREATE TABLE "countries" ("code" character(2) NOT NULL, "name_es" text NOT NULL, "name_en" text NOT NULL,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "countries_code_check" CHECK ("code" ~ '^[A-Z]{2}$'),
				CONSTRAINT "countries_pkey" PRIMARY KEY ("code"))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "countries" IS 'Países ISO 3166-1 alfa-2 (catálogo global; nombre en español e inglés). Lo lee la API'`
		);
		await queryRunner.query(`ALTER TABLE "countries" ENABLE ROW LEVEL SECURITY`);
		await queryRunner.query(
			`INSERT INTO "countries" ("code", "name_es", "name_en") SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT ("code") DO NOTHING`,
			[COUNTRIES.map((row) => row[0]), COUNTRIES.map((row) => row[1]), COUNTRIES.map((row) => row[2])]
		);

		// 2. Columna en companies
		await queryRunner.query(`ALTER TABLE "companies" ADD "country_code" character(2)`);
		await queryRunner.query(
			`COMMENT ON COLUMN "companies"."country_code" IS 'País ISO 3166-1 alfa-2 (FK countries). La API escribe también companies.country con el nombre en español'`
		);
		await queryRunner.query(
			`ALTER TABLE "companies" ADD CONSTRAINT "companies_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`
		);
		await queryRunner.query(`CREATE INDEX "idx_companies_country_code" ON "companies" ("country_code") `);

		// 3. Backfill desde el texto libre
		await queryRunner.query(
			`WITH names AS (
				SELECT code, ${NORMALIZE('name_es')} AS name FROM countries
				UNION SELECT code, ${NORMALIZE('name_en')} FROM countries
				UNION SELECT code, lower(code) FROM countries
				UNION SELECT alias.code, ${NORMALIZE('alias.name')} FROM unnest($1::text[], $2::text[]) AS alias(name, code)
			)
			UPDATE companies c SET country_code = n.code
			FROM names n
			WHERE c.country_code IS NULL AND c.country IS NOT NULL AND ${NORMALIZE('c.country')} = n.name`,
			[COUNTRY_ALIASES.map((row) => row[0]), COUNTRY_ALIASES.map((row) => row[1])]
		);
		const unmatched = (await queryRunner.query(
			`SELECT country, count(*) AS n FROM companies WHERE country_code IS NULL AND NULLIF(btrim(country), '') IS NOT NULL GROUP BY country ORDER BY country`
		)) as { country: string; n: string }[];

		if (unmatched.length) {
			console.warn(
				`[M7] Compañías con país sin calce (country_code queda NULL): ${unmatched.map((row) => `${row.country} (${row.n})`).join(', ')}`
			);
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_country_code"`);
		await queryRunner.query(`ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_country_code_fkey"`);
		await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "country_code"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "countries"`);
	}
}

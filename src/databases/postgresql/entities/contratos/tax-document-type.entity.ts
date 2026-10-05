import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Familia fiscal del documento: de ella se deriva `contracts.document_type` (`export_invoice` → FACTURA_EXPORTACION, resto → FACTURA). */
export const TAX_DOCUMENT_KINDS = ['invoice', 'export_invoice', 'credit_note', 'debit_note', 'receipt'] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

/** País comodín del catálogo: filas genéricas para compañías cuyo país no tiene documentos propios. */
export const GENERIC_TAX_COUNTRY = '*';

/**
 * Catálogo compartido de documentos tributarios por país (Contratos v2, `docs/v2-rediseno/mapa-v2-contratos.md` §6).
 *
 * NO es un espejo: es una tabla propia de api-sapira, creada por entity + migración `1790620000000-CreateTaxDocumentTypes`
 * y poblada por el seed `seed/003-tax-document-types.sql`. Sin holding: lo lee cualquier usuario autenticado
 * (`rls/tax_document_types_select_authenticated.sql`); solo se escribe por seed o migración.
 *
 * `code` es el código oficial del país cuando existe (SII 33/34/61…, SUNAT 01/03/07/08, CFDI-I/CFDI-E, DIAN FE/NC) o un
 * código genérico (`FACTURA`, `FACTURA_EXPORTACION`) para el país comodín `*`.
 */
@Entity({
	name: 'tax_document_types',
	comment:
		'Catálogo compartido de documentos tributarios por país (ISO-2, o * como comodín). code = código oficial cuando existe (SII 33/34/61, SUNAT 01/03, CFDI-I/E, DIAN FE/NC). kind = familia fiscal; de ella se deriva contracts.document_type',
})
@Unique('tax_document_types_country_code_code_key', ['country_code', 'code'])
@Index('idx_tax_document_types_country_active', ['country_code', 'active'])
@Check('tax_document_types_tax_rate_check', `"tax_rate" IS NULL OR ("tax_rate" >= 0 AND "tax_rate" <= 100)`)
@Check(
	'tax_document_types_kind_check',
	`"kind" = ANY (ARRAY['invoice'::text, 'export_invoice'::text, 'credit_note'::text, 'debit_note'::text, 'receipt'::text])`
)
export class TaxDocumentType {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'tax_document_types_pkey' })
	id: string;

	/** ISO-2 (`CL`, `PE`, `MX`, `CO`) o `*` para las filas genéricas. */
	@Column({ type: 'text', comment: 'País ISO-2 del documento, o * para el comodín genérico' })
	country_code: string;

	@Column({ type: 'text', comment: 'Código oficial del documento en su país (33, 01, CFDI-I, FE…) o genérico (FACTURA)' })
	code: string;

	@Column({ type: 'text', comment: 'Nombre en español neutro' })
	name: string;

	@Column({ type: 'text', comment: 'Familia fiscal: invoice, export_invoice, credit_note, debit_note o receipt' })
	kind: TaxDocumentKind;

	@Column({ type: 'boolean', default: false })
	is_electronic: boolean;

	@Column({ type: 'smallint', default: 0, comment: 'Orden de presentación dentro del país' })
	sort: number;

	@Column({ type: 'boolean', default: true })
	active: boolean;

	/** Facturas en el 360 §3.6 (migración 1790670000000): largo máximo de la glosa de una línea (SII `NmbItem` = 80); NULL = sin límite. */
	@Column({
		type: 'integer',
		nullable: true,
		comment: 'Largo máximo de la descripción de una línea en el documento (SII NmbItem = 80). NULL = sin límite',
	})
	description_max_chars?: number | null;

	/**
	 * Configuración v2 ronda 3 (migración 1790820000000-TaxDocumentTypesTaxRate, decisión de Domi 03-10): tasa de impuesto del documento en porcentaje (19 = 19 %).
	 * NULL = usa la tasa de la compañía. El motor la usa si el contrato tiene este documento (exportación sigue 0; Colombia sigue 0 y lo aplica el ERP).
	 */
	@Column({
		type: 'numeric',
		nullable: true,
		comment: 'Tasa de impuesto del documento en porcentaje (19 = 19 %). NULL = usa la tasa de la compañía',
	})
	tax_rate?: number | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;
}

/**
 * Ventana efectivamente procesada, inclusiva en ambos extremos.
 *
 * Se devuelve siempre, incluso cuando el llamador no envió rango: es la única forma de saber
 * qué ventana aplicó el default (el mes en curso, en zona America/Santiago).
 */
export interface QuantitiesDateRange {
	from: string;
	to: string;
}

/** Contadores de la fase 1: BigQuery → sapira_quantity_imports. */
export interface QuantitiesIngestResult {
	holdingId: string;
	range: QuantitiesDateRange;
	/** Filas devueltas por la consulta al DWH. */
	totalFromDwh: number;
	/** Filas descartadas por no traer clave natural (sf_id / billing_date / product). */
	discarded: number;
	/**
	 * Filas persistidas sin quantity ni unit_price: no son integrables, se guardan solo para
	 * vigilar cambios en el origen. Se cuentan aparte de inserted/updated (no son excluyentes).
	 */
	noQuantityData: number;
	/** Filas nuevas insertadas en la tabla intermedia. */
	inserted: number;
	/** Filas existentes cuyo payload cambió en el origen. */
	updated: number;
	/** Filas existentes idénticas (mismo source_hash). */
	unchanged: number;
	/** Filas ya integradas cuyo payload cambió después: pasan a changed_in_source. */
	changedInSource: number;
}

/** Contadores de la fase 2: sapira_quantity_imports → quantities. */
export interface QuantitiesIntegrationResult {
	holdingId: string;
	range: QuantitiesDateRange;
	/** Filas de la tabla intermedia tomadas para procesar en esta corrida. */
	totalProcessed: number;
	integrated: number;
	unmapped: number;
	notVariable: number;
	currencyMismatch: number;
	blocked: number;
	ambiguous: number;
	conflict: number;
}

/** Resultado combinado de fase 1 + fase 2, que es lo que expone el sync completo. */
export interface SapiraQuantitiesSyncResult {
	holdingId: string;
	range: QuantitiesDateRange;
	ingest: QuantitiesIngestResult;
	integration: QuantitiesIntegrationResult;
}

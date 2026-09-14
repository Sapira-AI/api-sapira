/**
 * Fila de `public.quantities` con los campos que el canal automático lee y escribe.
 *
 * Es el subconjunto que se usa para comparar contra el DWH y para devolver el resultado del
 * reemplazo manual. Los numéricos llegan como string porque son `numeric` de Postgres.
 *
 * Vive en `interfaces/` y no dentro del servicio porque es parte del contrato público del
 * endpoint de reemplazo: si queda como tipo interno, la emisión de declaraciones (`nest build`)
 * falla con TS4053 al no poder nombrarlo desde el controller.
 */
export interface QuantityRecord {
	id: string;
	unit_price: string | null;
	quantity: string | null;
	unit_of_measure: string | null;
	account: string | null;
}

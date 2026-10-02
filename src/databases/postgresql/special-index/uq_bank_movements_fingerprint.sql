-- Índice único parcial de public.bank_movements que TypeORM no puede declarar con @Index (expresión jsonb).
-- Idempotencia de línea de cartola (Conciliación v2, spec-conciliacion-v2 §2.1 #3, migración 1790740000000): una huella por holding.
-- Las filas sin huella (cargas del front viejo) quedan fuera del índice parcial.

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_movements_fingerprint ON public.bank_movements USING btree (holding_id, ((original_row_data ->> 'fingerprint'))) WHERE ((original_row_data ->> 'fingerprint') IS NOT NULL);

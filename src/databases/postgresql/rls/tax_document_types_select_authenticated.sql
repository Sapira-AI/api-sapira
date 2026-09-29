-- Catálogo compartido (sin holding): lo lee cualquier usuario autenticado. No hay policy de escritura a propósito:
-- las filas entran por seed o migración. La API entra con rol privilegiado y no pasa por RLS.
DROP POLICY IF EXISTS "tax_document_types_select_authenticated" ON "public"."tax_document_types";

CREATE POLICY "tax_document_types_select_authenticated"
ON "public"."tax_document_types"
AS PERMISSIVE
FOR SELECT
TO public
USING ((auth.role() = 'authenticated'::text));

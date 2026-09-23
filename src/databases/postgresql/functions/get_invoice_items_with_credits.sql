CREATE OR REPLACE FUNCTION public.get_invoice_items_with_credits(p_invoice_id uuid)
 RETURNS TABLE(item_id uuid, product_id uuid, product_name text, description text, quantity numeric, unit_price numeric, subtotal numeric, vat numeric, total numeric, item_source text, credit_note_id uuid, contract_item_id uuid, contract_categoria text)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  WITH main_invoice_items AS (
    -- Items de la factura principal
    SELECT 
      ii.id as item_id,
      ii.product_id,
      COALESCE(ci.product_name, ii.description) as product_name,
      ii.description,
      ii.quantity,
      ii.unit_price_invoice_currency as unit_price,
      ii.subtotal_invoice_currency as subtotal,
      ii.tax_amount_invoice_currency as vat,
      ii.total_invoice_currency as total,
      'main'::text as item_source,
      NULL::uuid as credit_note_id,
      ii.contract_item_id,
      ci.categoria as contract_categoria
    FROM public.invoice_items ii
    LEFT JOIN public.contract_items ci ON ci.id = ii.contract_item_id
    WHERE ii.invoice_id = p_invoice_id
  ),
  credit_notes AS (
    -- Notas de crédito relacionadas
    SELECT 
      ii.id as item_id,
      ii.product_id,
      COALESCE(ci.product_name, ii.description) as product_name,
      ii.description,
      ii.quantity,
      ii.unit_price_invoice_currency as unit_price,
      ii.subtotal_invoice_currency as subtotal,
      ii.tax_amount_invoice_currency as vat,
      ii.total_invoice_currency as total,
      'credit_note'::text as item_source,
      i.id as credit_note_id,
      ii.contract_item_id,
      ci.categoria as contract_categoria
    FROM public.invoices i
    JOIN public.invoice_items ii ON ii.invoice_id = i.id
    LEFT JOIN public.contract_items ci ON ci.id = ii.contract_item_id
    WHERE i.related_invoice_id = p_invoice_id
      AND i.document_type = 'NC' -- Cambio: usar document_type
  )
  SELECT * FROM main_invoice_items
  UNION ALL
  SELECT * FROM credit_notes
  ORDER BY item_source, product_name;
END;
$function$;

COMMENT ON FUNCTION public."get_invoice_items_with_credits"(p_invoice_id uuid) IS 'Retorna todos los items de una factura incluyendo los items de sus notas de crédito relacionadas';

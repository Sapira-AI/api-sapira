CREATE OR REPLACE FUNCTION public.get_odoo_partners_stg_debug(limit_count integer DEFAULT 5)
 RETURNS TABLE(id bigint, odoo_id integer, raw_data jsonb, processed_at timestamp without time zone, sync_batch_id text, holding_id uuid, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    ops.id,
    ops.odoo_id,
    ops.raw_data,
    ops.processed_at,
    ops.sync_batch_id,
    ops.holding_id,
    ops.created_at,
    ops.updated_at
  FROM odoo_partners_stg ops
  WHERE ops.holding_id IN (
    SELECT uh.holding_id 
    FROM user_holdings uh
    JOIN users u ON u.id = uh.user_id
    WHERE u.auth_id = auth.uid()
  )
  ORDER BY ops.created_at DESC
  LIMIT limit_count;
END;
$function$


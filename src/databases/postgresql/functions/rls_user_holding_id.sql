
  SELECT uh.holding_id
  FROM public.user_holdings uh
  INNER JOIN public.users u ON uh.user_id = u.id
  WHERE u.auth_id = auth.uid()
  LIMIT 1;

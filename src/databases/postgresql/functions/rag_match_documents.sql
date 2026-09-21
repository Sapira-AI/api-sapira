CREATE OR REPLACE FUNCTION public.rag_match_documents(query_embedding vector, match_count integer DEFAULT 5, match_threshold double precision DEFAULT 0.7)
 RETURNS TABLE(id uuid, content text, metadata jsonb, similarity double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    d.id,
    d.content,
    d.metadata,
    (1 - (d.embedding <=> query_embedding)) as similarity
  from public.rag_documents d
  where d.holding_id = public.get_current_user_holding_id()
    and d.embedding is not null
    and (1 - (d.embedding <=> query_embedding)) >= match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$function$


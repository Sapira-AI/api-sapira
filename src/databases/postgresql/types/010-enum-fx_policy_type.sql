-- Enum public.fx_policy_type. CREATE TYPE no admite IF NOT EXISTS, así que la
-- idempotencia va por guarda sobre pg_type. El orden de los labels es semántico
-- (comparaciones y ORDER BY) y no se puede alterar después de crearlo.

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE t.typname = 'fx_policy_type' AND n.nspname = 'public'
	) THEN
		CREATE TYPE "public"."fx_policy_type" AS ENUM ('holding_default', 'spot', 'monthly_avg', 'fixed', 'period_fixed', 'table');
	END IF;
END $$;

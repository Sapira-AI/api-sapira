-- Enum public.credit_note_reason. CREATE TYPE no admite IF NOT EXISTS, así que la
-- idempotencia va por guarda sobre pg_type. El orden de los labels es semántico
-- (comparaciones y ORDER BY) y no se puede alterar después de crearlo.

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE t.typname = 'credit_note_reason' AND n.nspname = 'public'
	) THEN
		CREATE TYPE "public"."credit_note_reason" AS ENUM ('downsell', 'churn', 'reschedule', 'issue_error', 'prompt_payment_discount', 'one_time_discount', 'compensation', 'other');
	END IF;
END $$;

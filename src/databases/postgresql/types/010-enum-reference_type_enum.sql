-- Enum public.reference_type_enum. CREATE TYPE no admite IF NOT EXISTS, así que la
-- idempotencia va por guarda sobre pg_type. El orden de los labels es semántico
-- (comparaciones y ORDER BY) y no se puede alterar después de crearlo.

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE t.typname = 'reference_type_enum' AND n.nspname = 'public'
	) THEN
		CREATE TYPE "public"."reference_type_enum" AS ENUM ('PO', 'HES', 'ACCEPTANCE', 'OTHER');
	END IF;
END $$;

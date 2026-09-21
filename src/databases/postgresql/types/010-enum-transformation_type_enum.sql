-- Enum public.transformation_type_enum. CREATE TYPE no admite IF NOT EXISTS, así que la
-- idempotencia va por guarda sobre pg_type. El orden de los labels es semántico
-- (comparaciones y ORDER BY) y no se puede alterar después de crearlo.

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE t.typname = 'transformation_type_enum' AND n.nspname = 'public'
	) THEN
		CREATE TYPE "public"."transformation_type_enum" AS ENUM ('direct', 'lookup_table', 'company_mapping', 'partner_mapping', 'custom_function', 'value_mapping');
	END IF;
END $$;

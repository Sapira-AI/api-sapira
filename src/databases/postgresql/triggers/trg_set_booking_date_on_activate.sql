DROP TRIGGER IF EXISTS "trg_set_booking_date_on_activate" ON "public"."contracts";

CREATE TRIGGER "trg_set_booking_date_on_activate"
BEFORE INSERT OR UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION set_booking_date_on_activate();

DROP TRIGGER IF EXISTS "trg_assign_invoice_group_id" ON "public"."invoices";

CREATE TRIGGER "trg_assign_invoice_group_id"
BEFORE INSERT
ON "public"."invoices"
FOR EACH ROW
EXECUTE FUNCTION assign_invoice_group_id();

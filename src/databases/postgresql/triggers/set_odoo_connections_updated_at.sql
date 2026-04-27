DROP TRIGGER IF EXISTS "set_odoo_connections_updated_at" ON "public"."odoo_connections";

CREATE TRIGGER "set_odoo_connections_updated_at"
BEFORE UPDATE
ON "public"."odoo_connections"
FOR EACH ROW
EXECUTE FUNCTION update_odoo_connections_updated_at();

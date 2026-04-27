DROP TRIGGER IF EXISTS "update_workflow_steps_updated_at" ON "public"."workflow_steps";

CREATE TRIGGER "update_workflow_steps_updated_at"
BEFORE UPDATE
ON "public"."workflow_steps"
FOR EACH ROW
EXECUTE FUNCTION update_workflow_steps_updated_at();

-- Número de contrato único por holding sin distinguir mayúsculas (contratos no borrados). Migración 1792510000000-ContractNumberUniqueCaseInsensitive.
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_holding_number_unique_ci" ON "contracts" ("holding_id", lower("contract_number")) WHERE "deleted_at" IS NULL;

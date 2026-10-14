CREATE UNIQUE INDEX plans_custom_name_uq
  ON plans (account_id, kind, name)
  WHERE account_id IS NOT NULL;
-- NeS ledger guards. Prisma cannot express these, so they are applied by hand.
--
-- Usage:
--   npx prisma migrate dev --create-only --name init
--   cat prisma/sql/ledger_guards.sql >> prisma/migrations/<timestamp>_init/migration.sql
--   npx prisma migrate dev
--
-- (For an already-migrated database, run this file once with psql instead.)

-- 1. Balances can never go negative, even if application code has a bug.
ALTER TABLE wallets ADD CONSTRAINT wallets_available_nonneg CHECK ("availableNes" >= 0);
ALTER TABLE wallets ADD CONSTRAINT wallets_pending_nonneg CHECK ("pendingNes" >= 0);
ALTER TABLE wallets ADD CONSTRAINT wallets_restricted_nonneg CHECK ("restrictedNes" >= 0);
ALTER TABLE merchant_accounts ADD CONSTRAINT merchant_settlement_nonneg CHECK ("settlementNes" >= 0);

-- 2. Every ledger entry moves a positive amount; every transaction records a real rate.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_positive CHECK ("amountNes" > 0);
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_tx_rate_positive CHECK ("conversionRate" > 0);

-- 3. Immutable financial records: ledger and audit tables are append-only.
CREATE OR REPLACE FUNCTION nes_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION nes_block_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION nes_block_mutation();

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION nes_block_mutation();
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION nes_block_mutation();

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION nes_block_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION nes_block_mutation();

-- 4. Double-entry: total debits must equal total credits per transaction, checked at COMMIT.
CREATE OR REPLACE FUNCTION nes_check_balanced() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT COALESCE(SUM("amountNes") FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM("amountNes") FILTER (WHERE direction = 'CREDIT'), 0)
    INTO d, c
    FROM ledger_entries
   WHERE "transactionId" = NEW."transactionId";
  IF d <> c THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced (debit %, credit %)', NEW."transactionId", d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nes_check_balanced();

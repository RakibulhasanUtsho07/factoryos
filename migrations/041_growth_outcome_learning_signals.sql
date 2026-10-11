BEGIN;

-- FR-GRO-12: link realised growth outcomes to append-only, factory-scoped AI evaluation signals.
ALTER TABLE growth_opportunity_outcomes
  ADD CONSTRAINT uq_growth_opportunity_outcome_scope
  UNIQUE (id, tenant_id, factory_id);

ALTER TABLE ai_learning_signals
  ALTER COLUMN source_decision_id DROP NOT NULL;

ALTER TABLE ai_learning_signals
  ADD COLUMN source_growth_outcome_id UUID;

ALTER TABLE ai_learning_signals
  ADD CONSTRAINT fk_ai_learning_growth_outcome_scope
  FOREIGN KEY (source_growth_outcome_id, tenant_id, factory_id)
  REFERENCES growth_opportunity_outcomes (id, tenant_id, factory_id)
  ON DELETE RESTRICT;

ALTER TABLE ai_learning_signals
  ADD CONSTRAINT chk_ai_learning_source_reference
  CHECK (source_decision_id IS NOT NULL OR source_growth_outcome_id IS NOT NULL);

CREATE INDEX idx_ai_learning_growth_outcome
  ON ai_learning_signals (tenant_id, factory_id, source_growth_outcome_id, created_at DESC)
  WHERE source_growth_outcome_id IS NOT NULL;

INSERT INTO schema_migrations (version, checksum)
VALUES ('041_growth_outcome_learning_signals', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

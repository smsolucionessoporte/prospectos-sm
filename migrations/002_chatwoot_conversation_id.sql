ALTER TABLE prospectos
ADD COLUMN IF NOT EXISTS chatwoot_conversation_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_prospectos_chatwoot_conversation_id
ON prospectos (chatwoot_conversation_id)
WHERE chatwoot_conversation_id IS NOT NULL;
ALTER TABLE rooms
  ADD COLUMN owner_user_id uuid,
  ADD COLUMN visibility varchar(10) NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private'));

CREATE INDEX rooms_owner_updated_idx
  ON rooms(owner_user_id, updated_at DESC)
  WHERE owner_user_id IS NOT NULL;

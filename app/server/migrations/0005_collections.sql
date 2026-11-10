-- Up Migration
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  kind text NOT NULL DEFAULT 'MANUAL' CHECK (kind IN ('MANUAL','AI_DRAFT','SMART','SAVED_SEARCH','PORTFOLIO','PUBLISHING')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  query jsonb,
  cover_photo_id uuid,
  created_by text NOT NULL DEFAULT 'USER' CHECK (created_by IN ('USER','AI')),
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CHECK (kind NOT IN ('SMART','SAVED_SEARCH') OR query IS NOT NULL),
  -- AI-created collections are drafts until a user activates them
  CHECK (created_by <> 'AI' OR status IN ('DRAFT','ARCHIVED') OR kind <> 'AI_DRAFT'),
  FOREIGN KEY (user_id, cover_photo_id) REFERENCES photos (user_id, id) ON DELETE SET NULL (cover_photo_id)
);
CREATE TRIGGER collections_updated BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX collections_name_uq ON collections (user_id, lower(name)) WHERE status <> 'ARCHIVED';
CREATE INDEX collections_kind_idx ON collections (user_id, kind, status);
CREATE INDEX collections_cover_idx ON collections (cover_photo_id) WHERE cover_photo_id IS NOT NULL;

CREATE TABLE collection_photos (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  photo_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  note text,
  added_by text NOT NULL DEFAULT 'USER' CHECK (added_by IN ('USER','AI')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, photo_id),
  FOREIGN KEY (user_id, collection_id) REFERENCES collections (user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, photo_id) REFERENCES photos (user_id, id) ON DELETE CASCADE
);
CREATE INDEX collection_photos_photo_idx ON collection_photos (user_id, photo_id);
CREATE INDEX collection_photos_order_idx ON collection_photos (collection_id, position);

-- Down Migration
DROP TABLE collection_photos;
DROP TABLE collections;

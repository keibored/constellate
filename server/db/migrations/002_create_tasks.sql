CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  room_id varchar(64) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title varchar(100) NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  completed boolean NOT NULL DEFAULT false,
  created_by varchar(64) NOT NULL CHECK (created_by ~ '^[A-Za-z0-9_-]{8,64}$'),
  creator_name varchar(24) NOT NULL,
  creator_avatar varchar(5) NOT NULL CHECK (creator_avatar IN ('dark', 'pink', 'green')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (room_id, request_id)
);
CREATE INDEX tasks_room_created_idx ON tasks (room_id, created_at, id);

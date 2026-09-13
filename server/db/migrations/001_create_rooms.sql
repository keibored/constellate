-- The existing URL slug is the primary key and unique room code.
CREATE TABLE rooms (
  id varchar(64) PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  name varchar(32) NOT NULL DEFAULT 'Late night grind' CHECK (length(btrim(name)) BETWEEN 1 AND 32),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

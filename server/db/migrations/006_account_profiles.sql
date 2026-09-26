CREATE TABLE account_profiles (
  user_id uuid PRIMARY KEY,
  nickname varchar(24) NOT NULL CHECK (length(btrim(nickname)) BETWEEN 1 AND 24),
  avatar varchar(5) NOT NULL CHECK (avatar IN ('dark', 'pink', 'green')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE room_study_sessions (
  id uuid PRIMARY KEY,
  room_id varchar(64) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  last_checkpoint_at timestamptz NOT NULL,
  CHECK (last_checkpoint_at >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX room_study_sessions_open_idx ON room_study_sessions(room_id) WHERE ended_at IS NULL;
CREATE INDEX room_study_sessions_history_idx ON room_study_sessions(room_id, started_at DESC, id DESC);

CREATE TABLE study_sessions (
  id uuid PRIMARY KEY,
  room_id varchar(64) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_study_session_id uuid NOT NULL REFERENCES room_study_sessions(id) ON DELETE CASCADE,
  guest_id varchar(64) NOT NULL CHECK (guest_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  last_checkpoint_at timestamptz NOT NULL,
  end_reason varchar(20) CHECK (end_reason IN ('left', 'shutdown', 'server_restart')),
  focus_ms bigint NOT NULL DEFAULT 0 CHECK (focus_ms >= 0),
  focus_seconds numeric GENERATED ALWAYS AS (focus_ms / 1000.0) STORED,
  completed_pomodoros integer NOT NULL DEFAULT 0 CHECK (completed_pomodoros >= 0),
  completed_tasks integer NOT NULL DEFAULT 0 CHECK (completed_tasks >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (last_checkpoint_at >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX study_sessions_open_guest_idx ON study_sessions(room_id, guest_id) WHERE ended_at IS NULL;
CREATE INDEX study_sessions_guest_history_idx ON study_sessions(guest_id, started_at DESC, id DESC);
CREATE INDEX study_sessions_room_idx ON study_sessions(room_id);
CREATE INDEX study_sessions_gathering_idx ON study_sessions(room_study_session_id);

-- Durable deduplication and time intervals let Today use the viewer's timezone.
-- reference_id is a focus interval, timer cycle or historical task UUID. It has
-- no task FK: deleting a task must not erase an already earned contribution.
CREATE TABLE study_activity (
  session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('focus', 'pomodoro', 'task')),
  reference_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  focus_ms bigint NOT NULL DEFAULT 0 CHECK (focus_ms >= 0),
  PRIMARY KEY (session_id, kind, reference_id),
  CHECK (ended_at >= started_at),
  CHECK ((kind = 'focus' AND focus_ms > 0 AND ended_at > started_at) OR
    (kind <> 'focus' AND focus_ms = 0 AND ended_at = started_at))
);
CREATE INDEX study_activity_time_idx ON study_activity(session_id, ended_at);

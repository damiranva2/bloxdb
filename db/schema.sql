CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 1 AND score <= 10),
  review TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ratings_game_id ON ratings (game_id);
CREATE INDEX IF NOT EXISTS idx_ratings_top ON ratings (game_id, score);

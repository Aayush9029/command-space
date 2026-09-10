use super::model::state_dir;
use rusqlite::{Connection, TransactionBehavior, params};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Exponentially decayed launch weights need only one accumulator and timestamp per item.
const HALF_LIFE_SECONDS: f64 = 14. * 24. * 60. * 60.;
const MAX_SEARCH_BONUS: f64 = 80.;
pub type Ranks = HashMap<String, (i64, bool)>;
pub type Activity = HashMap<String, Usage>;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub weight: f64,
    pub updated_at: i64,
}

impl Usage {
    pub fn value(self, now: i64) -> f64 {
        let weight = if self.weight.is_finite() {
            self.weight.max(0.)
        } else {
            0.
        };
        let age = now.saturating_sub(self.updated_at).max(0) as f64;
        weight * (-age / HALF_LIFE_SECONDS).exp2()
    }

    pub fn record(self, now: i64) -> Self {
        Self {
            weight: self.value(now) + 1.,
            updated_at: now.max(self.updated_at),
        }
    }

    pub fn bonus(self, now: i64) -> i64 {
        (24. * self.value(now).ln_1p())
            .min(MAX_SEARCH_BONUS)
            .round() as i64
    }
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

pub fn load() -> rusqlite::Result<(Ranks, Activity)> {
    let connection = database()?;
    migrate(&connection, now())?;
    read(&connection)
}

pub fn record(id: &str, now: i64) -> rusqlite::Result<((i64, bool), Usage)> {
    update(&mut database()?, id, now, false)
}

pub fn favorite(id: &str, now: i64) -> rusqlite::Result<((i64, bool), Usage)> {
    update(&mut database()?, id, now, true)
}

fn database() -> rusqlite::Result<Connection> {
    let _ = fs::create_dir_all(state_dir());
    open(&state_dir().join("history.db"))
}

fn open(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS ranking (
            id TEXT PRIMARY KEY,
            uses INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ranking_activity (
            id TEXT PRIMARY KEY,
            weight REAL NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    Ok(connection)
}

fn migrate(connection: &Connection, now: i64) -> rusqlite::Result<()> {
    // Old history has no timestamps: seed a bounded weight once without changing use counts or pins.
    connection.execute(
        "INSERT OR IGNORE INTO ranking_activity (id, weight, updated_at)
         SELECT id, MIN(MAX(uses, 0), 20), ?1 FROM ranking",
        [now],
    )?;
    Ok(())
}

fn read(connection: &Connection) -> rusqlite::Result<(Ranks, Activity)> {
    let mut statement = connection.prepare(
        "SELECT r.id, r.uses, r.favorite, COALESCE(a.weight, 0), COALESCE(a.updated_at, 0)
         FROM ranking r LEFT JOIN ranking_activity a ON r.id = a.id",
    )?;
    let mut ranks = Ranks::new();
    let mut activity = Activity::new();
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            (row.get(1)?, row.get(2)?),
            Usage {
                weight: row.get(3)?,
                updated_at: row.get(4)?,
            },
        ))
    })?;
    for row in rows {
        let (id, rank, usage) = row?;
        ranks.insert(id.clone(), rank);
        activity.insert(id, usage);
    }
    Ok((ranks, activity))
}

fn update(
    connection: &mut Connection,
    id: &str,
    now: i64,
    toggle_favorite: bool,
) -> rusqlite::Result<((i64, bool), Usage)> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT OR IGNORE INTO ranking (id, uses, favorite) VALUES (?1, 0, 0)",
        [id],
    )?;
    let (uses, favorite): (i64, bool) = transaction.query_row(
        "SELECT uses, favorite FROM ranking WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let usage = transaction
        .query_row(
            "SELECT weight, updated_at FROM ranking_activity WHERE id = ?1",
            [id],
            |row| {
                Ok(Usage {
                    weight: row.get(0)?,
                    updated_at: row.get(1)?,
                })
            },
        )
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(Usage {
                weight: uses.clamp(0, 20) as f64,
                updated_at: now,
            }),
            error => Err(error),
        })?;
    let (rank, usage) = if toggle_favorite {
        ((uses, !favorite), usage)
    } else {
        ((uses.saturating_add(1), favorite), usage.record(now))
    };
    transaction.execute(
        "UPDATE ranking SET uses = ?2, favorite = ?3 WHERE id = ?1",
        params![id, rank.0, rank.1],
    )?;
    transaction.execute(
        "INSERT INTO ranking_activity (id, weight, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at",
        params![id, usage.weight, usage.updated_at],
    )?;
    transaction.commit()?;
    Ok((rank, usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_weights_decay_smoothly_and_adapt_to_a_new_habit() {
        let now = 2_000_000_000;
        let recent = Usage::default().record(now);
        assert_eq!(recent.value(now), 1.);
        assert_eq!(recent.value(now + HALF_LIFE_SECONDS as i64), 0.5);
        assert_eq!(recent.record(now).value(now), 2.);
        let old = Usage {
            weight: 100.,
            updated_at: now - 10 * HALF_LIFE_SECONDS as i64,
        };
        assert!(recent.bonus(now) > old.bonus(now));
        assert!(recent.bonus(now + 60) <= recent.bonus(now));
        assert!(recent.bonus(now) <= MAX_SEARCH_BONUS as i64);
    }

    #[test]
    fn clock_rollback_and_invalid_weights_do_not_inflate_usage() {
        let recent = Usage {
            weight: 2.,
            updated_at: 500,
        };
        assert_eq!(recent.value(100), 2.);
        assert_eq!(recent.record(100).updated_at, 500);
        for weight in [f64::NAN, f64::INFINITY, -1.] {
            assert_eq!(
                Usage {
                    weight,
                    updated_at: 0
                }
                .bonus(0),
                0
            );
        }
    }

    #[test]
    fn old_history_migrates_once_preserving_counts_and_favorites() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch(
            "CREATE TABLE ranking (id TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0);
             INSERT INTO ranking VALUES ('firefox', 500, 1), ('foot', 3, 0);",
        ).unwrap();
        drop(legacy);
        let connection = open(&path).unwrap();
        migrate(&connection, 100).unwrap();
        let (ranks, activity) = read(&connection).unwrap();
        assert_eq!(ranks["firefox"], (500, true));
        assert_eq!(
            activity["firefox"],
            Usage {
                weight: 20.,
                updated_at: 100
            }
        );
        assert_eq!(activity["foot"].weight, 3.);
        drop(connection);
        let reopened = open(&path).unwrap();
        migrate(&reopened, 200).unwrap();
        assert_eq!(read(&reopened).unwrap(), (ranks, activity));
    }

    #[test]
    fn activity_survives_reopen_and_favorite_changes_do_not_count_as_launches() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let mut connection = open(&path).unwrap();
        update(&mut connection, "firefox", 100, false).unwrap();
        let expected = update(&mut connection, "firefox", 200, false).unwrap();
        let pinned = update(&mut connection, "firefox", 300, true).unwrap();
        assert_eq!(pinned.0, (2, true));
        assert_eq!(pinned.1, expected.1);
        drop(connection);
        let reopened = open(&path).unwrap();
        let (ranks, activity) = read(&reopened).unwrap();
        assert_eq!(ranks["firefox"], pinned.0);
        assert_eq!(activity["firefox"], pinned.1);
    }

    #[test]
    fn concurrent_writers_preserve_every_use_and_favorite_toggle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        drop(open(&path).unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(6));
        let threads = (0..6)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut connection = open(&path).unwrap();
                    barrier.wait();
                    for _ in 0..20 {
                        update(&mut connection, "firefox", 100, false).unwrap();
                    }
                    update(&mut connection, "firefox", 100, true).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        let connection = open(&path).unwrap();
        let (ranks, activity) = read(&connection).unwrap();
        assert_eq!(ranks["firefox"], (120, false));
        assert_eq!(activity["firefox"].weight, 120.);
    }
}

use super::model::{Action, Entry, home};
use nucleo_matcher::{
    Matcher, Utf32Str,
    pattern::{Atom, AtomKind, CaseMatching, Normalization},
};
use rusqlite::{Connection, params};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};
use walkdir::WalkDir;

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct File {
    path: String,
    name: String,
    directory: bool,
    modified: i64,
}

#[derive(Default)]
struct State {
    roots: Vec<PathBuf>,
    loaded: bool,
    generation: u64,
    request_generation: u64,
    scanning: bool,
    refreshed: Option<Instant>,
    files: Arc<Vec<File>>,
}

pub struct Index {
    database: PathBuf,
    state: Mutex<State>,
}

impl Index {
    pub fn new(database: PathBuf) -> Self {
        Self {
            database,
            state: Mutex::new(State::default()),
        }
    }

    #[cfg(test)]
    fn load(&self, roots: &[String]) -> Result<(), String> {
        let generation = self
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .request_generation
            .saturating_add(1);
        self.load_versioned(roots, generation).map(|_| ())
    }

    pub fn load_versioned(&self, roots: &[String], generation: u64) -> Result<bool, String> {
        let roots = normalize_roots(roots)?;
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if generation < state.request_generation {
            return Ok(false);
        }
        state.request_generation = generation;
        if state.loaded && state.roots == roots {
            return Ok(true);
        }
        state.generation = state.generation.wrapping_add(1);
        state.roots = roots;
        state.files = Arc::default();
        state.refreshed = None;
        state.loaded = true;
        if self.database.exists() {
            state.files = Arc::new(read_cache(&self.database, &state.roots)?);
        }
        Ok(true)
    }

    #[cfg(test)]
    fn refresh(&self, roots: &[String], force: bool) -> Result<bool, String> {
        let generation = self
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .request_generation
            .saturating_add(1);
        self.refresh_versioned(roots, force, generation)
    }

    pub fn refresh_versioned(
        &self,
        roots: &[String],
        force: bool,
        request_generation: u64,
    ) -> Result<bool, String> {
        // A broken cache must not prevent a fresh scan from reporting its own result.
        if matches!(self.load_versioned(roots, request_generation), Ok(false)) {
            return Ok(false);
        }
        let roots = normalize_roots(roots)?;
        let generation = {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            if state.roots != roots
                || state.scanning
                || request_generation < state.request_generation
            {
                return Ok(false);
            }
            if !force
                && state
                    .refreshed
                    .is_some_and(|time| time.elapsed() < REFRESH_INTERVAL)
            {
                return Ok(false);
            }
            state.scanning = true;
            state.generation
        };
        let result = scan(&roots, || {
            self.state
                .lock()
                .map(|state| state.generation != generation)
                .unwrap_or(true)
        });
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        state.scanning = false;
        if state.generation != generation {
            return Ok(false);
        }
        let Some(files) = result? else {
            return Ok(false);
        };
        // Publish only after the complete transaction succeeds, including when roots change mid-scan.
        write_cache(&self.database, &roots, &files)?;
        state.files = Arc::new(files);
        state.refreshed = Some(Instant::now());
        Ok(true)
    }

    pub fn search(
        &self,
        roots: &[String],
        query: &str,
        limit: usize,
        blacklist: &[String],
    ) -> Vec<Entry> {
        if limit == 0 {
            return Vec::new();
        }
        let Ok(roots) = normalize_roots(roots) else {
            return Vec::new();
        };
        let files = {
            let Ok(state) = self.state.lock() else {
                return Vec::new();
            };
            if state.roots != roots || !state.loaded {
                return Vec::new();
            }
            Arc::clone(&state.files)
        };
        let query = query.trim();
        let lower = query.to_lowercase();
        let atom = Atom::new(
            query,
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
            false,
        );
        let mut matcher = Matcher::new(nucleo_matcher::Config::DEFAULT);
        let mut buffer = Vec::new();
        let mut best = BinaryHeap::new();
        for (index, file) in files.iter().enumerate() {
            if blacklist.iter().any(|blocked| {
                blocked.strip_prefix("file:") == Some(file.path.as_str())
                    || blocked.eq_ignore_ascii_case(&file.name)
            }) {
                continue;
            }
            let relative = roots
                .iter()
                .find_map(|root| Path::new(&file.path).strip_prefix(root).ok())
                .and_then(Path::to_str)
                .unwrap_or("");
            let search_path = if Path::new(query).is_absolute() {
                file.path.as_str()
            } else {
                relative
            };
            let score = if query.is_empty() {
                0
            } else if let Some(score) =
                atom.score(Utf32Str::new(&file.name, &mut buffer), &mut matcher)
            {
                let name = file.name.to_lowercase();
                let quality = if name == lower {
                    30_000
                } else if name.starts_with(&lower) {
                    20_000
                } else if name.contains(&lower) {
                    10_000
                } else {
                    5_000
                };
                quality + i64::from(score).min(4_999)
            } else if let Some(score) =
                atom.score(Utf32Str::new(search_path, &mut buffer), &mut matcher)
            {
                i64::from(score).min(4_999)
            } else {
                continue;
            };
            let candidate = (score, file.modified, Reverse(file.path.as_str()), index);
            if best.len() >= limit && best.peek().is_some_and(|Reverse(last)| candidate <= *last) {
                continue;
            }
            // Only prospective results touch the filesystem; queries never traverse directories.
            if !Path::new(&file.path).exists() {
                continue;
            }
            best.push(Reverse(candidate));
            if best.len() > limit {
                best.pop();
            }
            if query.is_empty() && best.len() == limit {
                break;
            }
        }
        best.into_sorted_vec()
            .into_iter()
            .map(|Reverse((_, _, _, index))| {
                let file = &files[index];
                Entry::new(
                    &format!("file:{}", file.path),
                    &file.name,
                    &file.path,
                    if file.directory {
                        "icon:Folder"
                    } else {
                        "icon:Document"
                    },
                    Action::Open(file.path.clone()),
                )
            })
            .collect()
    }
}

fn normalize_roots(roots: &[String]) -> Result<Vec<PathBuf>, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut normalized = Vec::new();
    for root in roots.iter().filter(|root| !root.trim().is_empty()) {
        let path = if root == "~" {
            home()
        } else if let Some(suffix) = root.strip_prefix("~/") {
            home().join(suffix)
        } else {
            PathBuf::from(root)
        };
        let absolute = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let mut clean = PathBuf::new();
        for component in absolute.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    clean.pop();
                }
                other => clean.push(other.as_os_str()),
            }
        }
        normalized.push(clean);
    }
    normalized.sort();
    normalized.dedup();
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in normalized {
        if !roots.iter().any(|root| path.starts_with(root)) {
            roots.push(path);
        }
    }
    Ok(roots)
}

fn scan(roots: &[PathBuf], cancelled: impl Fn() -> bool) -> Result<Option<Vec<File>>, String> {
    let mut files = BTreeMap::new();
    for root in roots {
        match fs::metadata(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Cannot index {}: {error}", root.display())),
            Ok(_) => {}
        }
        let walker = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || {
                    let name = entry.file_name().to_string_lossy();
                    !name.starts_with('.')
                        && !matches!(name.as_ref(), "node_modules" | "target" | "vendor")
                }
            });
        for entry in walker {
            if cancelled() {
                return Ok(None);
            }
            let entry = entry.map_err(|e| format!("File index incomplete: {e}"))?;
            let path = entry.path();
            let metadata = match fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("Cannot index {}: {error}", path.display())),
            };
            if !metadata.is_file() && !metadata.is_dir() {
                continue;
            }
            let path = path
                .to_str()
                .ok_or_else(|| format!("Cannot index non-Unicode path: {}", path.display()))?
                .to_owned();
            let name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| format!("Cannot index non-Unicode filename: {path}"))?
                .to_owned();
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs().min(i64::MAX as u64) as i64)
                .unwrap_or_default();
            files.insert(
                path.clone(),
                File {
                    path,
                    name,
                    directory: metadata.is_dir(),
                    modified,
                },
            );
        }
    }
    let mut files: Vec<File> = files.into_values().collect();
    order_files(&mut files);
    Ok(Some(files))
}

fn roots_key(roots: &[PathBuf]) -> Result<String, String> {
    serde_json::to_string(roots).map_err(|e| e.to_string())
}

fn read_cache(path: &Path, roots: &[PathBuf]) -> Result<Vec<File>, String> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let key: String = transaction
        .query_row("SELECT roots FROM file_index_state WHERE id=1", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    if key != roots_key(roots)? {
        return Ok(Vec::new());
    }
    let mut statement = transaction
        .prepare("SELECT path, name, directory, modified FROM indexed_files ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(File {
                path: row.get(0)?,
                name: row.get(1)?,
                directory: row.get(2)?,
                modified: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut files: Vec<File> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    if files.iter().any(|file| {
        !roots
            .iter()
            .any(|root| Path::new(&file.path).starts_with(root))
    }) {
        return Err("File index contains a path outside configured roots".into());
    }
    order_files(&mut files);
    Ok(files)
}

fn order_files(files: &mut [File]) {
    files.sort_unstable_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
}

fn write_cache(path: &Path, roots: &[PathBuf], files: &[File]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_index_state (id INTEGER PRIMARY KEY, roots TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS indexed_files (
             path TEXT PRIMARY KEY, name TEXT NOT NULL, directory INTEGER NOT NULL, modified INTEGER NOT NULL
         );
         DELETE FROM indexed_files;
         DELETE FROM file_index_state;"
    ).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT INTO file_index_state (id, roots) VALUES (1, ?1)",
            [roots_key(roots)?],
        )
        .map_err(|e| e.to_string())?;
    {
        let mut insert = transaction
            .prepare("INSERT INTO indexed_files VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;
        for file in files {
            insert
                .execute(params![file.path, file.name, file.directory, file.modified])
                .map_err(|e| e.to_string())?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "super-space-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join("documents")).unwrap();
            Self(path)
        }

        fn index(&self) -> Index {
            Index::new(self.0.join("state/files.sqlite"))
        }

        fn roots(&self) -> Vec<String> {
            vec![self.0.join("documents").to_str().unwrap().into()]
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join("documents").join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "file content must never be searched").unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn persists_without_traversing_on_load_and_reconciles_add_rename_delete() {
        let fixture = Fixture::new();
        let old = fixture.file("draft.txt");
        let index = fixture.index();
        assert!(index.refresh(&fixture.roots(), false).unwrap());
        let cached = fixture.index();
        cached.load(&fixture.roots()).unwrap();
        assert_eq!(cached.search(&fixture.roots(), "draft", 20, &[]).len(), 1);
        let added = fixture.file("added.txt");
        assert!(cached.search(&fixture.roots(), "added", 20, &[]).is_empty());
        fs::rename(&old, old.with_file_name("final.txt")).unwrap();
        assert!(cached.search(&fixture.roots(), "draft", 20, &[]).is_empty());
        assert!(cached.refresh(&fixture.roots(), false).unwrap());
        assert_eq!(cached.search(&fixture.roots(), "final", 20, &[]).len(), 1);
        assert_eq!(cached.search(&fixture.roots(), "added", 20, &[]).len(), 1);
        fs::remove_file(added).unwrap();
        assert!(cached.refresh(&fixture.roots(), true).unwrap());
        assert!(cached.search(&fixture.roots(), "added", 20, &[]).is_empty());
        assert!(!cached.refresh(&fixture.roots(), false).unwrap());
    }

    #[test]
    fn indexes_deep_folders_and_files_with_literal_unicode_queries() {
        let fixture = Fixture::new();
        let deep = format!(
            "{}Résumé [2026] !final$ ^notes 'test' \\ data.txt",
            "nested/".repeat(30)
        );
        let path = fixture.file(&deep);
        let index = fixture.index();
        index.refresh(&fixture.roots(), false).unwrap();
        for query in [
            "Résumé", "rés", "[2026]", "!final$", "^notes", "'test'", "\\ data", "Rsm",
        ] {
            let results = index.search(&fixture.roots(), query, 10, &[]);
            assert_eq!(
                results[0].action,
                Action::Open(path.to_str().unwrap().into()),
                "{query}"
            );
        }
        assert_eq!(
            index.search(&fixture.roots(), path.to_str().unwrap(), 10, &[])[0].action,
            Action::Open(path.to_str().unwrap().into())
        );
        assert!(
            index
                .search(&fixture.roots(), "file content must never", 10, &[])
                .is_empty()
        );
        assert!(
            index
                .search(&fixture.roots(), "nested", 100, &[])
                .iter()
                .any(|entry| entry.icon == "icon:Folder")
        );
    }

    #[test]
    fn exclusions_overlap_roots_and_symlink_cycles_are_bounded() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.file("projects/visible.txt");
        for path in [
            ".secret",
            ".hidden/invisible",
            "node_modules/invisible",
            "target/invisible",
            "vendor/invisible",
        ] {
            fixture.file(path);
        }
        symlink(
            fixture.0.join("documents"),
            fixture.0.join("documents/projects/back"),
        )
        .unwrap();
        let mut roots = fixture.roots();
        roots.push(
            fixture
                .0
                .join("documents/projects")
                .to_str()
                .unwrap()
                .into(),
        );
        roots.push(format!("{}/./", roots[0]));
        let index = fixture.index();
        index.refresh(&roots, false).unwrap();
        assert!(index.search(&roots, "invisible", 20, &[]).is_empty());
        assert!(index.search(&roots, "secret", 20, &[]).is_empty());
        let results = index.search(&roots, "visible", 20, &[]);
        assert_eq!(results.len(), 1);
        assert!(index.search(&roots, "", 100, &[]).len() < 10);
    }

    #[test]
    fn returns_best_matches_after_hundreds_of_earlier_candidates_and_fills_past_blacklist() {
        let fixture = Fixture::new();
        for number in 0..350 {
            fixture.file(&format!("a-{number}-notes.txt"));
        }
        let exact = fixture.file("z/notes");
        fixture.file("notes-prefix.txt");
        let index = fixture.index();
        index.refresh(&fixture.roots(), false).unwrap();
        let results = index.search(&fixture.roots(), "notes", 3, &[]);
        assert_eq!(results.len(), 3);
        assert_eq!(
            results[0].action,
            Action::Open(exact.to_str().unwrap().into())
        );
        assert_eq!(results[1].title, "notes-prefix.txt");
        let blacklist = vec![results[0].id.clone(), "NOTES-PREFIX.TXT".into()];
        let filtered = index.search(&fixture.roots(), "notes", 3, &blacklist);
        assert_eq!(filtered.len(), 3);
        assert!(filtered.iter().all(|entry| entry.title.starts_with("a-")));
        assert_eq!(index.search(&fixture.roots(), "n", 4, &[]).len(), 4);
        assert_eq!(index.search(&fixture.roots(), "", 4, &[]).len(), 4);
        assert!(index.search(&fixture.roots(), "", 0, &[]).is_empty());
        assert_eq!(
            results.iter().map(|entry| &entry.id).collect::<Vec<_>>(),
            index
                .search(&fixture.roots(), "notes", 3, &[])
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn changing_roots_clears_results_and_does_not_reuse_another_roots_cache() {
        let fixture = Fixture::new();
        fixture.file("original.txt");
        fs::create_dir_all(fixture.0.join("other")).unwrap();
        fs::write(fixture.0.join("other/another.txt"), "other").unwrap();
        let other = vec![fixture.0.join("other").to_str().unwrap().into()];
        let index = fixture.index();
        index.refresh(&fixture.roots(), false).unwrap();
        assert!(index.search(&other, "original", 10, &[]).is_empty());
        index.load(&other).unwrap();
        assert!(
            index
                .search(&fixture.roots(), "original", 10, &[])
                .is_empty()
        );
        assert!(index.search(&other, "", 10, &[]).is_empty());
        index.refresh(&other, false).unwrap();
        assert_eq!(index.search(&other, "another", 10, &[]).len(), 1);
        let restarted = fixture.index();
        restarted.load(&fixture.roots()).unwrap();
        assert!(restarted.search(&fixture.roots(), "", 10, &[]).is_empty());
    }

    #[test]
    fn missing_roots_are_empty_and_incomplete_scans_preserve_previous_snapshot() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        fixture.file("keep.txt");
        let mut roots = fixture.roots();
        roots.push(fixture.0.join("missing").to_str().unwrap().into());
        let index = fixture.index();
        index.refresh(&roots, false).unwrap();
        let private = fixture.0.join("documents/private");
        fs::create_dir(&private).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o0)).unwrap();
        let inaccessible = fs::read_dir(&private).is_err();
        let result = index.refresh(&roots, true);
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        if inaccessible {
            assert!(result.unwrap_err().contains("incomplete"));
            assert_eq!(index.search(&roots, "keep", 10, &[]).len(), 1);
            let cached = fixture.index();
            cached.load(&roots).unwrap();
            assert!(cached.search(&roots, "private", 10, &[]).is_empty());
        }
    }

    #[test]
    fn failed_persistence_does_not_publish_partial_memory_or_database_snapshot() {
        let fixture = Fixture::new();
        fixture.file("keep.txt");
        let index = fixture.index();
        index.refresh(&fixture.roots(), false).unwrap();
        let database = Connection::open(&index.database).unwrap();
        database.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON indexed_files BEGIN SELECT RAISE(ABORT, 'test write failure'); END;").unwrap();
        fixture.file("uncommitted.txt");
        assert!(
            index
                .refresh(&fixture.roots(), true)
                .unwrap_err()
                .contains("test write failure")
        );
        assert!(
            index
                .search(&fixture.roots(), "uncommitted", 10, &[])
                .is_empty()
        );
        let cached = fixture.index();
        cached.load(&fixture.roots()).unwrap();
        assert_eq!(cached.search(&fixture.roots(), "keep", 10, &[]).len(), 1);
        assert!(
            cached
                .search(&fixture.roots(), "uncommitted", 10, &[])
                .is_empty()
        );
    }

    #[test]
    fn concurrent_refreshes_publish_once_and_busy_root_changes_never_leak() {
        let fixture = Fixture::new();
        for number in 0..100 {
            fixture.file(&format!("record-{number}"));
        }
        let index = Arc::new(fixture.index());
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let index = Arc::clone(&index);
            let barrier = Arc::clone(&barrier);
            let roots = fixture.roots();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                index.refresh(&roots, false).unwrap()
            }));
        }
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .filter(|result| *result)
                .count(),
            1
        );
        index.state.lock().unwrap().scanning = true;
        let old_generation = index.state.lock().unwrap().generation;
        let other = vec![fixture.0.join("other").to_str().unwrap().into()];
        index.load(&other).unwrap();
        assert_ne!(index.state.lock().unwrap().generation, old_generation);
        assert!(!index.refresh(&other, true).unwrap());
        assert!(index.search(&other, "", 10, &[]).is_empty());
        assert!(index.search(&fixture.roots(), "", 10, &[]).is_empty());
        let count = std::cell::Cell::new(0);
        let result = scan(&normalize_roots(&fixture.roots()).unwrap(), || {
            count.set(count.get() + 1);
            count.get() > 3
        })
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    #[ignore = "creates a 10,000-file fixture for explicit indexing performance measurements"]
    fn cached_search_ten_thousand_files() {
        let fixture = Fixture::new();
        for number in 0..10_000 {
            fixture.file(&format!("project-{}/report-{number:05}.txt", number % 100));
        }
        let index = fixture.index();
        let scan_started = Instant::now();
        index.refresh(&fixture.roots(), false).unwrap();
        let scan_time = scan_started.elapsed();
        let cached = fixture.index();
        let load_started = Instant::now();
        cached.load(&fixture.roots()).unwrap();
        let load_time = load_started.elapsed();
        let mut measurements = Vec::new();
        for query in ["", "r", "rpt9999", "report-09999", "project-99/"] {
            let started = Instant::now();
            let results = cached.search(&fixture.roots(), query, 50, &[]);
            assert!(!results.is_empty(), "{query}");
            assert!(results.len() <= 50);
            measurements.push((query, started.elapsed()));
        }
        eprintln!(
            "10k file index: scan={scan_time:?}, cached load={load_time:?}, queries={measurements:?}"
        );
    }

    #[test]
    fn late_requests_cannot_restore_old_roots_or_cancel_a_current_snapshot() {
        let fixture = Fixture::new();
        fixture.file("old.txt");
        fs::create_dir_all(fixture.0.join("other")).unwrap();
        fs::write(fixture.0.join("other/new.txt"), "new").unwrap();
        let roots = fixture.roots();
        let other = vec![fixture.0.join("other").to_str().unwrap().into()];
        let index = fixture.index();
        assert!(index.refresh_versioned(&roots, false, 1).unwrap());
        assert!(index.refresh_versioned(&other, false, 3).unwrap());
        assert!(!index.load_versioned(&roots, 2).unwrap());
        assert!(!index.refresh_versioned(&roots, true, 2).unwrap());
        assert_eq!(index.search(&other, "new", 10, &[]).len(), 1);
        assert!(index.search(&roots, "old", 10, &[]).is_empty());
        let scan_generation = index.state.lock().unwrap().generation;
        assert!(index.load_versioned(&other, 4).unwrap());
        assert_eq!(index.state.lock().unwrap().generation, scan_generation);
        assert!(!index.load_versioned(&roots, 3).unwrap());
    }
}

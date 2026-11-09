SNAPSHOT = {
    "root": "/company/android/reader-app", "name": "reader-app", "branch": "feature/offline-reading",
    "upstream": "origin/feature/offline-reading", "ahead": 2, "behind": 1, "merging": False,
    "remotes": ["origin"],
    "shelves": [],
    "head": {"hash": "a" * 40, "message": "Merge offline reader improvements\n\nPreserve offline progress."},
    "changes": [
        {"path": "app/src/main/ReaderActivity.kt", "index": " ", "worktree": "M", "conflict": False},
        {"path": "app/src/main/res/layout/reader.xml", "index": "M", "worktree": " ", "conflict": False},
        {"path": "app/src/main/OfflineCache.kt", "index": "?", "worktree": "?", "conflict": False},
    ],
    "commits": [
        {"hash": "a" * 40, "parents": ["b" * 40, "c" * 40], "author": "Junpeng Liu", "date": "2026-11-03T10:32:00+08:00", "refs": "HEAD -> feature/offline-reading", "subject": "Merge offline reader improvements"},
        {"hash": "b" * 40, "parents": ["d" * 40], "author": "Chen", "date": "2026-11-02T14:12:00+08:00", "refs": "origin/main", "subject": "Restore reading progress across sessions"},
        {"hash": "c" * 40, "parents": ["d" * 40], "author": "Junpeng Liu", "date": "2026-11-02T11:06:00+08:00", "refs": "", "subject": "Cache chapters for offline reading"},
        {"hash": "d" * 40, "parents": [], "author": "Wang", "date": "2026-11-01T09:00:00+08:00", "refs": "", "subject": "Add reader page layout"},
    ],
    "branches": [
        {"name": "feature/offline-reading", "current": True, "remote": False, "upstream": "origin/feature/offline-reading", "tracking": "[ahead 2, behind 1]"},
        {"name": "main", "current": False, "remote": False, "upstream": "origin/main", "tracking": ""},
        {"name": "origin/main", "current": False, "remote": True, "upstream": "", "tracking": ""},
    ],
}


def state(page, snapshot=SNAPSHOT, **extra):
    page.evaluate("s => window.postMessage(s, '*')", {"type": "state", "snapshot": snapshot, "root": snapshot["root"], "busy": False, "loading": False, "error": "", **extra})

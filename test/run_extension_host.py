"""Launch installed VS Code with isolated data and disposable test repositories."""
import os
import json
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
default = "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
executable = os.environ.get("VSCODE_EXECUTABLE", default)
with tempfile.TemporaryDirectory(prefix="pg-smoke-", dir="/tmp" if os.name != "nt" else None) as temp:
    base = Path(temp).resolve()
    workspace = base / "workspace"
    workspace.mkdir()
    settings = base / "user-data/User"
    settings.mkdir(parents=True)
    (settings / "settings.json").write_text(json.dumps({"chat.disableAIFeatures": True, "telemetry.telemetryLevel": "off", "extensions.autoUpdate": False, "extensions.autoCheckUpdates": False, "workbench.startupEditor": "none"}))
    env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
    result = subprocess.run([
        executable, str(workspace),
        f"--extensionDevelopmentPath={root}",
        f"--extensionTestsPath={root / 'dist/test/extension-host'}",
        f"--user-data-dir={base / 'user-data'}",
        f"--extensions-dir={base / 'extensions'}",
        "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
        "--disable-updates", "--disable-telemetry", "--disable-gpu", "--new-window",
    ], env=env, timeout=90, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        print(result.stdout)
        raise SystemExit(result.returncode)
    for line in result.stdout.splitlines():
        if "checks passed" in line:
            print(line)

#!/usr/bin/env bash
# Run a python script with whichever interpreter has pyreadr: prefer a working
# .venv, else the system python3 (which may have a --user install).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ] && .venv/bin/python -c "import pyreadr" 2>/dev/null; then
  exec .venv/bin/python "$@"
fi
exec "${PYTHON:-python3}" "$@"

#!/usr/bin/env bash
# Ensure pyreadr is importable. Used only by Module A to read the bzip2+R/XDR
# gpheats.rda / gpsquads.rda datasets. Prefers a local .venv; falls back to a
# --user install when python3-venv is unavailable (common on minimal Debian).
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3}"

if [ -x .venv/bin/python ] && .venv/bin/python -c "import pyreadr" 2>/dev/null; then
  echo "pyreadr already available in .venv"
  exit 0
fi
if "$PY" -c "import pyreadr" 2>/dev/null; then
  echo "pyreadr already available in $PY"
  exit 0
fi

# Try a virtualenv first.
if "$PY" -m venv .venv 2>/dev/null; then
  .venv/bin/pip install --quiet --upgrade pip || true
  if .venv/bin/pip install --quiet pyreadr; then
    .venv/bin/python -c "import pyreadr; print('  pyreadr', pyreadr.__version__, '(venv)')"
    exit 0
  fi
fi

# Fall back to a user-site install against the system interpreter.
echo "venv unavailable; installing pyreadr to user site ..."
rm -rf .venv 2>/dev/null || true
"$PY" -m pip install --user --quiet pyreadr
"$PY" -c "import pyreadr; print('  pyreadr', pyreadr.__version__, '(user site)')"

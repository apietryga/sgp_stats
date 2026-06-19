#!/usr/bin/env python3
"""Module A (part 1): download the historical SGP datasets from gogonzo/sport
and convert them to intermediate CSV for the TypeScript ingest.

The .rda files are bzip2-compressed R/XDR; pyreadr (librdata) reads them natively.
Every download is stored raw under data/raw/ with a .meta.json sidecar recording
url / fetched_at / sha256, so the TypeScript side can attach real provenance to
every results row. Idempotent: skips re-download when the on-disk sha matches.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
UA = "sgp-stats/0.1 (personal speedway statistics; contact: antoni.pietryga@linkhouse.co)"

SOURCES = {
    "gpheats": "https://raw.githubusercontent.com/gogonzo/sport/master/data/gpheats.rda",
    "gpsquads": "https://raw.githubusercontent.com/gogonzo/sport/master/data/gpsquads.rda",
}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def rel_from_root(abs_path: str) -> str:
    return os.path.relpath(abs_path, ROOT).replace(os.sep, "/")


def download_with_meta(name: str, url: str) -> str:
    """Download <name>.rda to data/raw/ unless a valid cached copy exists.
    Returns the absolute path to the .rda file."""
    os.makedirs(RAW_DIR, exist_ok=True)
    rda_path = os.path.join(RAW_DIR, f"sport_{name}.rda")
    meta_path = rda_path + ".meta.json"

    if os.path.exists(rda_path) and os.path.exists(meta_path):
        with open(rda_path, "rb") as fh:
            cur = sha256_hex(fh.read())
        with open(meta_path) as fh:
            meta = json.load(fh)
        if meta.get("sha256") == cur:
            print(f"  [cache] {name}: sha matches, skip download")
            return rda_path

    print(f"  [fetch] {name} <- {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
        ctype = resp.headers.get("Content-Type")
    with open(rda_path, "wb") as fh:
        fh.write(body)
    meta = {
        "url": url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "sha256": sha256_hex(body),
        "bytes": len(body),
        "content_type": ctype,
        "raw_file": rel_from_root(rda_path),
    }
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"          {len(body)} bytes, sha {meta['sha256'][:12]}...")
    return rda_path


def convert(name: str, rda_path: str) -> None:
    import pyreadr  # imported here so download step works even without pyreadr

    result = pyreadr.read_r(rda_path)
    # The object is keyed by its R name; take the single data frame.
    key = next(iter(result.keys()))
    df = result[key]
    out_csv = os.path.join(RAW_DIR, f"_{name}.csv")
    df.to_csv(out_csv, index=False)
    print(f"  [csv]   {name}: {len(df)} rows, cols={list(df.columns)} -> {rel_from_root(out_csv)}")


def main() -> int:
    print("Module A: ingest gogonzo/sport (1995-2019 historical heats)")
    try:
        import pyreadr  # noqa: F401
    except ImportError:
        print(
            "ERROR: pyreadr not installed. Run `bun run setup:py` first "
            "(creates .venv with pyreadr), or `pip install pyreadr`.",
            file=sys.stderr,
        )
        return 1
    for name, url in SOURCES.items():
        path = download_with_meta(name, url)
        convert(name, path)
    print("Module A part 1 done. Now run the TS ingest (src/ingest_sport.ts).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

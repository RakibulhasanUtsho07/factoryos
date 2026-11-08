#!/usr/bin/env python3
"""Verify the source-located 92-row v1.9 growth/research delta candidate ledger.

The source PDF is supplied by the operator and is not included in this repository.
Requires: python -m pip install pdfplumber
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

SOURCE_SHA256 = "09f796a867941d4738b07eea5f9169ed2de9351fb7a6111b676bf9342bfbb5a1"
SOURCE_PAGE_COUNT = 86
FIRST_SOURCE_PAGE = 75
LAST_SOURCE_PAGE = 85
ROW_PATTERN = re.compile(r"^\s*((?:FR|NFR)-[A-Z0-9]+-\d{2,3})\s+(.+?)\s+(P[012])\s*$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_rows(pdf_path: Path) -> list[dict[str, Any]]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber is required: python -m pip install pdfplumber") from exc

    source_hash = sha256_file(pdf_path)
    if source_hash != SOURCE_SHA256:
        raise ValueError(f"Source SHA-256 mismatch: expected {SOURCE_SHA256}, got {source_hash}")

    rows: list[dict[str, Any]] = []
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != SOURCE_PAGE_COUNT:
            raise ValueError(f"Expected {SOURCE_PAGE_COUNT} source pages; got {len(pdf.pages)}")
        for zero_based_page in range(FIRST_SOURCE_PAGE - 1, LAST_SOURCE_PAGE):
            page = pdf.pages[zero_based_page]
            page_text = page.extract_text(layout=True) or ""
            for line_number, line in enumerate(page_text.splitlines(), start=1):
                match = ROW_PATTERN.match(line)
                if not match:
                    continue
                requirement_id, _wording_candidate, priority = match.groups()
                rows.append({
                    "requirementId": requirement_id,
                    "priority": priority,
                    "pdfPage": zero_based_page + 1,
                    "textLineOnPage": line_number,
                })
    return rows


def verify(pdf_path: Path, ledger_path: Path) -> dict[str, Any]:
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    actual = extract_rows(pdf_path)
    expected = ledger.get("rows")
    if not isinstance(expected, list) or actual != expected:
        actual_by_id = {row["requirementId"]: row for row in actual}
        expected_by_id = {
            row.get("requirementId"): row
            for row in expected or []
            if isinstance(row, dict)
        }
        all_ids = sorted(set(actual_by_id) | set(expected_by_id))
        differing = [value for value in all_ids if actual_by_id.get(value) != expected_by_id.get(value)]
        raise ValueError("Source row/priority/page locator mismatch for: " + ", ".join(differing[:30]))

    ids = [row["requirementId"] for row in actual]
    if len(actual) != 92 or len(set(ids)) != 92:
        raise ValueError(f"Expected 92 unique occurrences; got {len(actual)} rows / {len(set(ids))} IDs")
    types = Counter("NFR" if value.startswith("NFR-") else "FR" for value in ids)
    priorities = Counter(row["priority"] for row in actual)
    expected_types = {"FR": 74, "NFR": 18}
    expected_priorities = {"P0": 37, "P1": 55, "P2": 0}
    if dict(types) != expected_types:
        raise ValueError(f"Functional/non-functional count mismatch: {dict(types)}")
    if {key: priorities.get(key, 0) for key in expected_priorities} != expected_priorities:
        raise ValueError(f"Priority count mismatch: {dict(priorities)}")
    if ledger.get("sourceArtifactSha256") != SOURCE_SHA256:
        raise ValueError("Ledger source hash does not match the required source artifact")
    return {
        "rows": len(actual),
        "distinct_ids": len(set(ids)),
        "functional": types["FR"],
        "non_functional": types["NFR"],
        "priorities": {key: priorities.get(key, 0) for key in ("P0", "P1", "P2")},
        "pages": [FIRST_SOURCE_PAGE, LAST_SOURCE_PAGE],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument(
        "--ledger",
        type=Path,
        default=Path("docs/srs-v19-growth-delta-occurrence-ledger.json"),
    )
    args = parser.parse_args()
    try:
        result = verify(args.source_pdf, args.ledger)
        print(
            "PASS: "
            f"{result['rows']} unique v1.9 growth/research rows; "
            f"FR={result['functional']} NFR={result['non_functional']}; "
            f"P0={result['priorities']['P0']} P1={result['priorities']['P1']} P2={result['priorities']['P2']}; "
            f"PDF pages {result['pages'][0]}-{result['pages'][1]}."
        )
        print("Approval boundary: candidate extraction only; source-owner acceptance remains separate.")
        return 0
    except Exception as exc:  # noqa: BLE001 - fail closed on source or ledger drift.
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

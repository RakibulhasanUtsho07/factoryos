#!/usr/bin/env python3
"""Verify the hash-pinned 50-row v2.1 delta requirement extraction.

Requires: python -m pip install pdfplumber
The source PDF is intentionally supplied by the caller and is not redistributed
in this repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

SOURCE_SHA256 = "ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959"
EXPECTED_IDS = (
    [f"FR-PROD-{i:02d}" for i in range(1, 33)]
    + [f"NFR-PROD-{i:02d}" for i in range(1, 19)]
)
EXPECTED_PRIORITY_COUNTS = {"P0": 35, "P1": 15}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_wording(value: str) -> str:
    # Only collapse a true line-wrap hyphen; preserve constructs such as "role- and".
    value = unicodedata.normalize("NFC", value)
    value = re.sub(r"-\n\s*", "-", value)
    return " ".join(value.split())


def extract_rows(pdf_path: Path) -> list[dict]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber is required: python -m pip install pdfplumber") from exc

    extracted: list[dict] = []
    last_row: dict | None = None
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 103:
            raise ValueError(f"Expected 103 source pages; got {len(pdf.pages)}")
        # PDF pages 96-99; pdfplumber page indexes are zero-based.
        for page_number in range(96, 100):
            page = pdf.pages[page_number - 1]
            for table_index, table in enumerate(page.extract_tables(), start=1):
                if not table:
                    continue
                header = [(cell or "").strip().lower() for cell in table[0]]
                if len(header) < 3 or header[:3] != ["id", "requirement", "priority"]:
                    continue
                for row_index, cells in enumerate(table[1:], start=2):
                    cells = list(cells) + [""] * (3 - len(cells))
                    requirement_id, wording, priority = [
                        (cells[index] or "").strip() for index in range(3)
                    ]
                    if re.fullmatch(r"(?:FR|NFR)-PROD-\d{2}", requirement_id):
                        last_row = {
                            "requirementId": requirement_id,
                            "priority": priority,
                            "pdfPage": page_number,
                            "tableIndex": table_index,
                            "rowIndex": row_index,
                            "normalizedWordingSha256": "",
                            "_wording": wording,
                        }
                        extracted.append(last_row)
                    elif not requirement_id and wording and last_row is not None:
                        # The only split rows in this delta are FR-PROD-12 and FR-PROD-25.
                        if last_row["requirementId"] in {"FR-PROD-12", "FR-PROD-25"}:
                            last_row["_wording"] = (last_row["_wording"] + " " + wording).strip()
                            if priority:
                                last_row["priority"] = priority

    for row in extracted:
        wording = normalize_wording(row.pop("_wording"))
        row["normalizedWordingSha256"] = hashlib.sha256(wording.encode("utf-8")).hexdigest()
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument(
        "--ledger",
        type=Path,
        default=Path("docs/srs-v21-delta-occurrence-ledger.json"),
    )
    args = parser.parse_args()

    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
        actual_source_sha = sha256_file(args.source_pdf)
        if actual_source_sha != SOURCE_SHA256 or actual_source_sha != ledger["sourceArtifactSha256"]:
            raise ValueError(
                f"Source SHA-256 mismatch: expected {SOURCE_SHA256}, got {actual_source_sha}"
            )
        actual = extract_rows(args.source_pdf)
        expected = [
            {
                "requirementId": row[0],
                "priority": row[1],
                "pdfPage": row[2],
                "tableIndex": row[3],
                "rowIndex": row[4],
                "normalizedWordingSha256": row[5],
            }
            for row in ledger["rows"]
        ]
        if actual != expected:
            actual_by_id = {row["requirementId"]: row for row in actual}
            expected_by_id = {row["requirementId"]: row for row in expected}
            ids = sorted(set(actual_by_id) | set(expected_by_id))
            differences = [
                requirement_id
                for requirement_id in ids
                if actual_by_id.get(requirement_id) != expected_by_id.get(requirement_id)
            ]
            raise ValueError("Source occurrence mismatch for: " + ", ".join(differences))
        ids = [row["requirementId"] for row in actual]
        if ids != EXPECTED_IDS or len(set(ids)) != 50:
            raise ValueError("Expected the ordered FR-PROD-01..32 and NFR-PROD-01..18 population")
        priority_counts = dict(Counter(row["priority"] for row in actual))
        if priority_counts != EXPECTED_PRIORITY_COUNTS:
            raise ValueError(f"Priority mismatch: {priority_counts}")
        print(
            "PASS: 50/50 v2.1 delta rows, source locators, priorities and wording SHA-256 digests verified "
            f"(P0={priority_counts['P0']}, P1={priority_counts['P1']}, P2=0)."
        )
        print("Formal source-owner approval and the inherited 900-row population remain separate gates.")
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI must report malformed source/ledger as a failure.
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

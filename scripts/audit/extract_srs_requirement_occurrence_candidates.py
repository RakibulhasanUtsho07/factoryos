#!/usr/bin/env python3
"""Extract source-located candidate rows from SRS requirement tables.

This tool does not decide whether an occurrence is active, canonical, inherited,
superseded, duplicate, or approved. It extracts table-positioned FR/NFR rows
from the caller-supplied source PDF and keeps ambiguous page-boundary fragments
separate for human reconciliation. Requires pdfplumber.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

EXTRACTOR_VERSION = "1.0.0"
EXPECTED_SOURCE_SHA256 = "ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959"
EXPECTED_PAGE_COUNT = 103
REQUIREMENT_ID = re.compile(r"(?:FR|NFR)-[A-Z0-9]+-\d{2,3}\Z")
SECTION_NUMBER = re.compile(r"\d{1,3}(?:\.\d+){0,2}\.?\Z")
PRIORITIES = {"P0", "P1", "P2"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_extracted_cell(words: list[dict[str, Any]]) -> str:
    ordered = sorted(words, key=lambda word: (round(float(word["top"]), 2), float(word["x0"])))
    value = " ".join(str(word["text"]) for word in ordered)
    return " ".join(unicodedata.normalize("NFC", value).split())


def _group_lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    lines: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (float(item["top"]), float(item["x0"]))):
        if lines and abs(float(lines[-1][0]["top"]) - float(word["top"])) < 1.5:
            lines[-1].append(word)
        else:
            lines.append([word])
    return lines


def _is_section_heading(line: list[dict[str, Any]], req_x: float) -> bool:
    ordered = sorted(line, key=lambda item: float(item["x0"]))
    if not ordered:
        return False
    first = ordered[0]
    if float(first["x0"]) >= req_x - 30 or not SECTION_NUMBER.fullmatch(str(first["text"])):
        return False
    return float(first.get("size", 0) or 0) >= 10.5 or "bold" in str(first.get("fontname", "")).lower()


def _table_headers(lines: list[list[dict[str, Any]]]) -> list[dict[str, float]]:
    headers = []
    for line in lines:
        by_text = {str(word["text"]): word for word in line
                   if str(word["text"]) in {"ID", "Requirement", "Priority"}}
        if not all(key in by_text for key in ("ID", "Requirement", "Priority")):
            continue
        id_x, req_x, pri_x = (float(by_text[key]["x0"]) for key in ("ID", "Requirement", "Priority"))
        if id_x < req_x < pri_x:
            headers.append({"top": min(float(w["top"]) for w in line),
                            "bottom": max(float(w["bottom"]) for w in line),
                            "id_x": id_x, "req_x": req_x, "pri_x": pri_x})
    return headers


def extract_page_candidates(page: Any, page_number: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    words = page.extract_words(extra_attrs=["size", "fontname"])
    lines = _group_lines(words)
    headers = _table_headers(lines)
    occurrences, fragments = [], []

    for table_index, header in enumerate(headers, start=1):
        next_header_top = headers[table_index]["top"] if table_index < len(headers) else float(page.height) - 40
        section_end = next_header_top
        for line in lines:
            line_top = min(float(word["top"]) for word in line)
            if header["bottom"] + 1 < line_top < next_header_top - 1 and _is_section_heading(line, header["req_x"]):
                section_end = min(section_end, line_top - 3)

        anchors = [word for word in words
                   if REQUIREMENT_ID.fullmatch(str(word["text"]))
                   and header["id_x"] - 4 <= float(word["x0"]) < header["req_x"] - 4
                   and header["bottom"] + 1 < float(word["top"]) < section_end]
        anchors.sort(key=lambda item: float(item["top"]))
        if not anchors:
            continue

        first_anchor_top = float(anchors[0]["top"])
        leading_words = [word for word in words
                         if header["req_x"] - 3 <= float(word["x0"]) < header["pri_x"] - 1
                         and header["bottom"] + 1 < float(word["top"]) < first_anchor_top - 1]
        leading_text = normalize_extracted_cell(leading_words)
        leading_fragment_words, first_row_prefix_words = [], []
        if leading_text and page_number > 1 and header["top"] < 75:
            leading_lines = _group_lines(leading_words)
            boundary_line_count = 0
            for line_index in range(1, len(leading_lines)):
                prior = sorted(leading_lines[line_index - 1], key=lambda item: float(item["x0"]))
                current = sorted(leading_lines[line_index], key=lambda item: float(item["x0"]))
                if str(prior[-1]["text"]).endswith((".", ";", ":", "?", "!")) and str(current[0]["text"])[:1].isupper():
                    boundary_line_count = line_index
                    break
            if boundary_line_count:
                leading_fragment_words = [w for line in leading_lines[:boundary_line_count] for w in line]
                first_row_prefix_words = [w for line in leading_lines[boundary_line_count:] for w in line]
            elif leading_text[:1].islower():
                leading_fragment_words = leading_words
            else:
                first_row_prefix_words = leading_words

        fragment_text = normalize_extracted_cell(leading_fragment_words)
        if fragment_text:
            fragments.append({"source_pdf_page": page_number, "table_index_on_page": table_index,
                              "fragment_kind": "LOWERCASE_LEADING_PAGE_CONTINUATION_CANDIDATE",
                              "extracted_text": fragment_text, "disposition": "UNRESOLVED_REVIEW_REQUIRED"})

        for row_index, anchor in enumerate(anchors, start=1):
            anchor_top = float(anchor["top"])
            row_top = ((float(anchors[row_index - 2]["top"]) + anchor_top) / 2
                       if row_index > 1 else header["bottom"] + 2)
            row_bottom = ((anchor_top + float(anchors[row_index]["top"])) / 2
                          if row_index < len(anchors) else section_end)
            if row_index == 1 and fragment_text:
                row_top = (min(float(w["top"]) for w in first_row_prefix_words)
                           if first_row_prefix_words else anchor_top - 1)
            cell_words = [word for word in words
                          if header["req_x"] - 3 <= float(word["x0"]) < header["pri_x"] - 1
                          and row_top <= float(word["top"]) < row_bottom]
            wording = normalize_extracted_cell(cell_words)
            priority_tokens = sorted({str(word["text"]) for word in words
                                      if float(word["x0"]) >= header["pri_x"] - 3
                                      and row_top <= float(word["top"]) < row_bottom
                                      and str(word["text"]) in PRIORITIES})
            priority = priority_tokens[0] if len(priority_tokens) == 1 else None
            status = "TABLE_ROW_CANDIDATE" if wording and priority else "PARTIAL_EXTRACTION_REVIEW_REQUIRED"
            key = f"p{page_number:03d}-t{table_index:02d}-r{row_index:03d}-{anchor['text']}"
            occurrences.append({
                "source_occurrence_key": key, "source_pdf_page": page_number,
                "source_table_index_on_page": table_index, "source_row_index_in_table": row_index,
                "requirement_id": str(anchor["text"]), "source_priority_candidate": priority,
                "source_priority_tokens": priority_tokens, "extracted_normative_text_candidate": wording,
                "extracted_text_sha256": hashlib.sha256(wording.encode("utf-8")).hexdigest(),
                "extraction_status": status, "occurrence_class": "UNRESOLVED",
                "canonical_requirement_id": None, "source_owner_decision_ref": None,
                "reviewer": None, "review_date": None,
            })
    return occurrences, fragments


def extract_pdf(pdf_path: Path, expected_sha256: str = EXPECTED_SOURCE_SHA256) -> dict[str, Any]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber is required: python -m pip install pdfplumber") from exc
    source_sha = sha256_file(pdf_path)
    if expected_sha256 and source_sha != expected_sha256:
        raise ValueError(f"Source SHA-256 mismatch: expected {expected_sha256}, got {source_sha}")
    occurrences, fragments = [], []
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != EXPECTED_PAGE_COUNT:
            raise ValueError(f"Expected {EXPECTED_PAGE_COUNT} source pages; got {len(pdf.pages)}")
        for page_number, page in enumerate(pdf.pages, start=1):
            rows, page_fragments = extract_page_candidates(page, page_number)
            occurrences.extend(rows)
            fragments.extend(page_fragments)
    id_counts = Counter(row["requirement_id"] for row in occurrences)
    priority_counts = Counter(row["source_priority_candidate"] for row in occurrences)
    return {
        "schema_version": 1, "extractor_version": EXTRACTOR_VERSION,
        "source_artifact_sha256": source_sha, "source_pdf_page_count": EXPECTED_PAGE_COUNT,
        "extraction_kind": "POSITIONED_FR_NFR_REQUIREMENT_TABLE_OCCURRENCES",
        "candidate_occurrence_count": len(occurrences), "distinct_requirement_id_count": len(id_counts),
        "priority_candidate_counts": {key: priority_counts.get(key, 0) for key in ("P0", "P1", "P2")},
        "duplicate_id_occurrence_counts": {key: count for key, count in sorted(id_counts.items()) if count > 1},
        "partial_extraction_count": sum(row["extraction_status"] != "TABLE_ROW_CANDIDATE" for row in occurrences),
        "boundary_fragment_count": len(fragments),
        "acceptance_boundary": (
            "Candidate extraction only. These rows are not the 950-row active baseline and are not an approved "
            "occurrence classification. No active/superseded/duplicate/excluded decision or source-owner approval "
            "is inferred. Boundary fragments remain separate pending Requirements/Product review."
        ),
        "occurrences": occurrences, "boundary_fragments": fragments,
    }


def write_csv(path: Path, ledger: dict[str, Any]) -> None:
    columns = ["source_occurrence_key", "source_pdf_page", "source_table_index_on_page",
               "source_row_index_in_table", "requirement_id", "source_priority_candidate",
               "extracted_normative_text_candidate", "extracted_text_sha256", "extraction_status",
               "occurrence_class", "canonical_requirement_id", "source_owner_decision_ref", "reviewer", "review_date"]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ledger["occurrences"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--csv-output", type=Path)
    parser.add_argument("--expected-source-sha256", default=EXPECTED_SOURCE_SHA256)
    args = parser.parse_args()
    try:
        ledger = extract_pdf(args.source_pdf, args.expected_source_sha256)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if args.csv_output:
            args.csv_output.parent.mkdir(parents=True, exist_ok=True)
            write_csv(args.csv_output, ledger)
        counts = ledger["priority_candidate_counts"]
        print(f"PASS: {ledger['candidate_occurrence_count']} occurrences / {ledger['distinct_requirement_id_count']} distinct IDs; P0={counts['P0']} P1={counts['P1']} P2={counts['P2']}")
        print("UNRESOLVED: active-scope reconciliation, occurrence classification and all owner approvals.")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

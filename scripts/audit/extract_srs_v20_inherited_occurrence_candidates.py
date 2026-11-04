#!/usr/bin/env python3
"""Build a hash-pinned, source-located candidate census from the SRS v2.0 PDF.

Diagnostic only: no requirement wording is emitted or persisted, and no active,
canonical, superseded, duplicate, inherited or excluded status is inferred.
Requires pdfplumber.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

EXTRACTOR_VERSION = "1.0.0"
SOURCE_SHA256 = "8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42"
SOURCE_PAGE_COUNT = 93
REQUIREMENT_ID = re.compile(r"(?:FR|NFR)-[A-Z0-9]+-\d{2,3}\Z")
SECTION_NUMBER = re.compile(r"\d{1,3}(?:\.\d+){0,2}\.?\Z")
PRIORITIES = {"P0", "P1", "P2"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def group_words_into_lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    lines: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (float(item["top"]), float(item["x0"]))):
        if lines and abs(float(lines[-1][0]["top"]) - float(word["top"])) < 1.5:
            lines[-1].append(word)
        else:
            lines.append([word])
    return lines


def normalized_text_sha256(words: list[dict[str, Any]]) -> str | None:
    ordered = sorted(words, key=lambda item: (round(float(item["top"]), 2), float(item["x0"])))
    raw = " ".join(str(word["text"]) for word in ordered)
    normalized = " ".join(unicodedata.normalize("NFC", raw).split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else None


def detect_header_schemas(lines: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    schemas: list[dict[str, Any]] = []
    for line in lines:
        by_text: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for word in line:
            by_text[str(word["text"]).strip()].append(word)
        if "ID" not in by_text or "Priority" not in by_text:
            continue
        id_word = min(by_text["ID"], key=lambda item: float(item["x0"]))
        priority_word = min(by_text["Priority"], key=lambda item: float(item["x0"]))
        middle_words = [
            word for word in line
            if float(id_word["x0"]) < float(word["x0"]) < float(priority_word["x0"])
            and str(word["text"]) not in {"ID", "Priority"}
        ]
        if not middle_words:
            continue
        header_tokens = sorted({str(word["text"]) for word in line})
        schemas.append({
            "top": min(float(word["top"]) for word in line),
            "bottom": max(float(word["bottom"]) for word in line),
            "id_x": float(id_word["x0"]),
            "middle_x": min(float(word["x0"]) for word in middle_words),
            "priority_x": float(priority_word["x0"]),
            "table_kind": "NORMATIVE_REQUIREMENT_TABLE" if "Requirement" in header_tokens else "AUXILIARY_CATALOGUE_TABLE",
            "header_tokens": header_tokens,
        })
    return schemas


def _section_end(lines: list[list[dict[str, Any]]], schema: dict[str, Any], start: float, end: float) -> float:
    for line in lines:
        if not line:
            continue
        line_top = min(float(word["top"]) for word in line)
        if not start + 1 < line_top < end - 1:
            continue
        ordered = sorted(line, key=lambda item: float(item["x0"]))
        first = ordered[0]
        if float(first["x0"]) > float(schema["id_x"]) + 20:
            continue
        if not SECTION_NUMBER.fullmatch(str(first["text"])):
            continue
        if float(first.get("size", 0) or 0) >= 10.5 or "bold" in str(first.get("fontname", "")).lower():
            return min(end, line_top - 3)
    return end


def extract_page_candidates(
    page: Any, page_number: int, prior_schema: dict[str, Any] | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None]:
    words = page.extract_words(extra_attrs=["size", "fontname"])
    lines = group_words_into_lines(words)
    schemas = detect_header_schemas(lines)
    regions: list[tuple[dict[str, Any], float, float, int, str]] = []

    if schemas:
        first_header_top = float(schemas[0]["top"])
        if prior_schema:
            carried = {**prior_schema, "continuation": True}
            region_end = (
                float(page.height) - 35
                if page_number in {10, 18, 19}
                else _section_end(lines, carried, 0.0, first_header_top)
            )
            regions.append((carried, 35.0, region_end, 0, "CARRIED_FROM_PREVIOUS_PAGE"))
        for index, schema in enumerate(schemas):
            region_end = float(schemas[index + 1]["top"]) if index + 1 < len(schemas) else float(page.height) - 35
            region_end = _section_end(lines, schema, float(schema["bottom"]), region_end)
            regions.append((schema, float(schema["bottom"]) + 1, region_end, index + 1, "PAGE_HEADER"))
        next_schema = schemas[-1]
    elif prior_schema:
        carried = {**prior_schema, "continuation": True}
        region_end = (
            float(page.height) - 35
            if page_number in {10, 18, 19}
            else _section_end(lines, carried, 0.0, float(page.height) - 35)
        )
        regions.append((carried, 35.0, region_end, 0, "CARRIED_FROM_PREVIOUS_PAGE"))
        next_schema = prior_schema
    else:
        next_schema = None

    occurrences: list[dict[str, Any]] = []
    for schema, region_start, region_end, table_index, schema_source in regions:
        anchors = [
            word for word in words
            if REQUIREMENT_ID.fullmatch(str(word["text"]))
            and float(schema["id_x"]) - 10 <= float(word["x0"]) < float(schema["middle_x"]) - 3
            and region_start < float(word["top"]) < region_end
        ]
        anchors.sort(key=lambda item: float(item["top"]))
        for row_index, anchor in enumerate(anchors, start=1):
            anchor_top = float(anchor["top"])
            row_top = (float(anchors[row_index - 2]["top"]) + anchor_top) / 2 if row_index > 1 else region_start
            row_bottom = (anchor_top + float(anchors[row_index]["top"])) / 2 if row_index < len(anchors) else region_end
            wording_words = [
                word for word in words
                if float(schema["middle_x"]) - 3 <= float(word["x0"]) < float(schema["priority_x"]) - 1
                and row_top <= float(word["top"]) < row_bottom
            ]
            priority_tokens = sorted({
                str(word["text"]) for word in words
                if float(word["x0"]) >= float(schema["priority_x"]) - 3
                and row_top <= float(word["top"]) < row_bottom
                and str(word["text"]) in PRIORITIES
            })
            wording_hash = normalized_text_sha256(wording_words)
            table_kind = schema["table_kind"]
            if schema_source == "CARRIED_FROM_PREVIOUS_PAGE" and page_number in {18, 19}:
                table_kind = "SCOPE_LEDGER_OR_CROSSWALK_CANDIDATE"
            elif schema_source == "CARRIED_FROM_PREVIOUS_PAGE" and page_number == 10:
                table_kind = "METRIC_OR_DECISION_CROSS_REFERENCE_CANDIDATE"
            if table_kind in {"SCOPE_LEDGER_OR_CROSSWALK_CANDIDATE", "METRIC_OR_DECISION_CROSS_REFERENCE_CANDIDATE"}:
                status = "NON_NORMATIVE_CONTEXT_CANDIDATE"
            elif wording_hash and len(priority_tokens) == 1:
                status = "TABLE_ROW_CANDIDATE"
            elif len(priority_tokens) > 1:
                status = "AMBIGUOUS_PRIORITY_REVIEW_REQUIRED"
            elif not wording_hash:
                status = "WORDING_NOT_EXTRACTED_REVIEW_REQUIRED"
            else:
                status = "PRIORITY_NOT_EXTRACTED_REVIEW_REQUIRED"
            occurrences.append({
                "source_occurrence_key": f"v20-p{page_number:03d}-t{table_index:02d}-r{row_index:03d}-{anchor['text']}",
                "source_pdf_page": page_number,
                "source_table_index_on_page": table_index,
                "source_row_index_in_table": row_index,
                "source_schema_origin": schema_source,
                "table_kind_candidate": table_kind,
                "header_tokens": schema["header_tokens"],
                "continued_from_prior_page": schema_source == "CARRIED_FROM_PREVIOUS_PAGE",
                "requirement_id_candidate": str(anchor["text"]),
                "source_priority_candidate": priority_tokens[0] if len(priority_tokens) == 1 else None,
                "source_priority_tokens": priority_tokens,
                "normalized_wording_sha256": wording_hash,
                "extraction_status": status,
                "occurrence_class": "UNRESOLVED",
                "canonical_requirement_id": None,
                "source_owner_decision_ref": None,
            })

    mapped_ids = {
        (row["requirement_id_candidate"], page_number) for row in occurrences
    }
    # Only flag ID tokens positioned in a known table's ID column. Requirement
    # wording commonly contains IDs as cross-references; treating those as
    # missing table-row anchors creates false orphan candidates.
    id_column_regions = [
        (float(schema["id_x"]) - 10, float(schema["middle_x"]) - 3)
        for schema in schemas
    ]
    if not id_column_regions and prior_schema:
        id_column_regions = [
            (float(prior_schema["id_x"]) - 10, float(prior_schema["middle_x"]) - 3)
        ]
    unresolved_lines: list[dict[str, Any]] = []
    for line in lines:
        ordered = sorted(line, key=lambda item: float(item["x0"]))
        ids = [
            word for word in ordered
            if REQUIREMENT_ID.fullmatch(str(word["text"]))
            and any(low <= float(word["x0"]) < high for low, high in id_column_regions)
        ]
        priority_words = [word for word in ordered if str(word["text"]) in PRIORITIES]
        if ids and priority_words:
            for anchor in ids:
                if (
                    (str(anchor["text"]), page_number) not in mapped_ids
                    and min(float(word["x0"]) for word in priority_words) > float(anchor["x0"])
                ):
                    unresolved_lines.append({
                        "source_pdf_page": page_number,
                        "requirement_id_candidate": str(anchor["text"]),
                        "line_text_sha256": normalized_text_sha256(ordered),
                        "disposition": "UNRESOLVED_TABLE_LOCATOR_REVIEW",
                    })
    return occurrences, unresolved_lines, next_schema


def build_ledger(source_pdf: Path) -> dict[str, Any]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber is required: python -m pip install pdfplumber") from exc
    actual_sha = sha256_file(source_pdf)
    if actual_sha != SOURCE_SHA256:
        raise ValueError(f"Source SHA-256 mismatch: expected {SOURCE_SHA256}, got {actual_sha}")

    occurrences: list[dict[str, Any]] = []
    unresolved_lines: list[dict[str, Any]] = []
    prior_schema: dict[str, Any] | None = None
    with pdfplumber.open(source_pdf) as pdf:
        if len(pdf.pages) != SOURCE_PAGE_COUNT:
            raise ValueError(f"Expected {SOURCE_PAGE_COUNT} PDF pages; got {len(pdf.pages)}")
        for page_number, page in enumerate(pdf.pages, start=1):
            rows, lines, prior_schema = extract_page_candidates(page, page_number, prior_schema)
            occurrences.extend(rows)
            unresolved_lines.extend(lines)

    priority_counts = Counter(
        row["source_priority_candidate"] for row in occurrences
        if row["source_priority_candidate"] in PRIORITIES
    )
    id_counts = Counter(row["requirement_id_candidate"] for row in occurrences)
    statuses = Counter(row["extraction_status"] for row in occurrences)
    kinds = Counter(row["table_kind_candidate"] for row in occurrences)
    normative_rows = [
        row for row in occurrences
        if row["table_kind_candidate"] == "NORMATIVE_REQUIREMENT_TABLE"
        and row["extraction_status"] == "TABLE_ROW_CANDIDATE"
    ]
    normative_priority_counts = Counter(row["source_priority_candidate"] for row in normative_rows)
    normative_id_counts = Counter(row["requirement_id_candidate"] for row in occurrences
                                  if row["table_kind_candidate"] == "NORMATIVE_REQUIREMENT_TABLE")
    auxiliary_rows = [row for row in occurrences
                      if row["table_kind_candidate"] == "AUXILIARY_CATALOGUE_TABLE"]
    auxiliary_priority_counts = Counter(row["source_priority_candidate"] for row in auxiliary_rows)
    return {
        "schema_version": 1,
        "ledger_id": "FOS-SRS-V20-INHERITED-CANDIDATE-01",
        "extractor_version": EXTRACTOR_VERSION,
        "source_filename": source_pdf.name,
        "source_artifact_sha256": actual_sha,
        "source_pdf_page_count": SOURCE_PAGE_COUNT,
        "scope_claim": {
            "inherited_v20_cumulative_requirements": 900,
            "cumulative_priority_claim": {"P0": 261, "P1": 567, "P2": 72},
            "claim_source": "SRS v2.1 §140, as recorded in docs/srs-requirement-scope-reconciliation.md",
            "claim_status": "SOURCE_DECLARED_ARITHMETIC_NOT_ROW_LEVEL_RECONCILIATION",
        },
        "extraction_kind": "POSITIONED_ID_PRIORITY_TABLE_OCCURRENCE_CANDIDATES",
        "candidate_occurrence_count": len(occurrences),
        "distinct_id_candidate_count": len(id_counts),
        "candidate_priority_counts_including_auxiliary_catalogue": {
            key: priority_counts.get(key, 0) for key in ("P0", "P1", "P2")
        },
        "normative_requirement_table_candidate_count": len(normative_rows),
        "normative_distinct_id_candidate_count": len(normative_id_counts),
        "normative_priority_counts": {
            key: normative_priority_counts.get(key, 0) for key in ("P0", "P1", "P2")
        },
        "auxiliary_catalogue_candidate_count": len(auxiliary_rows),
        "auxiliary_catalogue_priority_counts": {
            key: auxiliary_priority_counts.get(key, 0) for key in ("P0", "P1", "P2")
        },
        "non_normative_context_candidate_count": (
            kinds.get("SCOPE_LEDGER_OR_CROSSWALK_CANDIDATE", 0)
            + kinds.get("METRIC_OR_DECISION_CROSS_REFERENCE_CANDIDATE", 0)
        ),
        "table_kind_candidate_counts": dict(sorted(kinds.items())),
        "extraction_status_counts": dict(sorted(statuses.items())),
        "repeated_id_candidates": {key: count for key, count in sorted(id_counts.items()) if count > 1},
        "repeated_normative_id_candidates": {
            key: count for key, count in sorted(normative_id_counts.items()) if count > 1
        },
        "unresolved_line_candidate_count": len(unresolved_lines),
        "acceptance_boundary": (
            "Candidate extraction only. The result does not establish the 900 active inherited v2.0 "
            "occurrence set, canonical IDs, applicability, supersession, duplicate status or source-owner "
            "acceptance. Auxiliary catalogue rows remain separate from normative requirement-table candidates. "
            "Page-continuation handling is heuristic; partial rows and unresolved lines require review. "
            "No requirement is marked PASS or owner-approved."
        ),
        "occurrences": occurrences,
        "unresolved_line_candidates": unresolved_lines,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-pdf", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        ledger = build_ledger(args.source_pdf)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        counts = ledger["normative_priority_counts"]
        print(
            f"PASS: {ledger['normative_requirement_table_candidate_count']} normative-table candidates / "
            f"{ledger['normative_distinct_id_candidate_count']} distinct IDs; "
            f"P0={counts['P0']} P1={counts['P1']} P2={counts['P2']}; "
            f"{ledger['auxiliary_catalogue_candidate_count']} auxiliary and "
            f"{ledger['non_normative_context_candidate_count']} non-normative context rows kept separate."
        )
        print("BOUNDARY: active 900-row baseline and source-owner decisions remain unresolved.")
        return 0
    except Exception as exc:  # noqa: BLE001 - fail closed on source or parser drift.
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

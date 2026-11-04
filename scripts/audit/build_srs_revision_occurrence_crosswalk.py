#!/usr/bin/env python3
"""Join hash-pinned SRS candidate ledgers into a revision-aware ID crosswalk.

Inputs are candidate metadata ledgers, never normative wording. The builder
fails closed on source hashes, populations, revision-delta parity, priority
consistency, wording-hash comparison totals and the 37-row owner-decision set.
It never assigns active/canonical/superseded/duplicate/excluded/PASS status.
"""
from __future__ import annotations
import argparse
import base64
import csv
import gzip
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

SOURCE = {
    "v20": ("8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42", 93),
    "v19": ("09f796a867941d4738b07eea5f9169ed2de9351fb7a6111b676bf9342bfbb5a1", 86),
    "v21": ("ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959", 103),
}
V21_CSV_SHA256 = "f71bf35c082f92377b4b4a4f9590eb0a078c525e2cc5e29d39a75781b0ebf502"
V21_DELTA_IDS = (
    {f"FR-PROD-{i:02d}" for i in range(1, 33)}
    | {f"NFR-PROD-{i:02d}" for i in range(1, 19)}
)
MACHINE_CANDIDATES = {
    "CROSS_REFERENCE_CANDIDATE",
    "HISTORY_REFERENCE_CANDIDATE",
    "KPI_REFERENCE_CANDIDATE",
}
UNAPPROVED_FIELDS = (
    "canonicalRequirementId", "canonicalSourceDocumentReference",
    "canonicalSourceRevision", "canonicalNormativeWording", "sourcePriority",
    "sourceOwnerDecisionRef", "reviewer", "reviewDate",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def build(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    v20 = read_json(args.v20_ledger)
    v19 = read_json(args.v19_ledger)
    v21_delta_ledger = read_json(args.v21_delta_ledger)
    v20_hash, v20_pages = SOURCE["v20"]
    v19_hash, v19_pages = SOURCE["v19"]
    v21_hash, v21_pages = SOURCE["v21"]

    if v20.get("source_artifact_sha256") != v20_hash or v20.get("source_pdf_page_count") != v20_pages:
        raise ValueError("v2.0 ledger source SHA/page count mismatch")
    if v19.get("sourceArtifactSha256") != v19_hash or v19.get("sourcePdfPageCount") != v19_pages:
        raise ValueError("v1.9 ledger source SHA/page count mismatch")

    v20_occ = v20.get("occurrences")
    if not isinstance(v20_occ, list):
        raise ValueError("v2.0 ledger occurrences array is missing")
    v20_normative = [
        row for row in v20_occ
        if row.get("table_kind_candidate") == "NORMATIVE_REQUIREMENT_TABLE"
        and row.get("extraction_status") == "TABLE_ROW_CANDIDATE"
    ]
    v20_by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in v20_normative:
        v20_by[row["requirement_id_candidate"]].append({
            "pdf_page": row["source_pdf_page"],
            "table_index": row["source_table_index_on_page"],
            "row_index": row["source_row_index_in_table"],
            "priority_candidate": row["source_priority_candidate"],
            "normalized_wording_sha256": row["normalized_wording_sha256"],
        })
    if len(v20_normative) != 809 or len(v20_by) != 799:
        raise ValueError("v2.0 normative candidate population mismatch")

    v19_rows = v19.get("rows")
    if not isinstance(v19_rows, list) or len(v19_rows) != 92:
        raise ValueError("v1.9 growth delta must contain 92 rows")
    v19_by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in v19_rows:
        v19_by[row["requirementId"]].append({
            "pdf_page": row["pdfPage"],
            "text_line": row["textLineOnPage"],
            "priority_candidate": row["priority"],
        })
    v19_ids = set(v19_by)
    if len(v19_ids) != 92:
        raise ValueError("v1.9 growth delta IDs are not unique")

    if sha256_file(args.v21_candidates_csv) != V21_CSV_SHA256:
        raise ValueError("v2.1 full-PDF candidate CSV SHA-256 mismatch")
    v21_rows_raw = read_csv(args.v21_candidates_csv)
    if len(v21_rows_raw) != 857:
        raise ValueError(f"Expected 857 v2.1 full-PDF table candidates, got {len(v21_rows_raw)}")
    v21_rows = [{
        "id": row["requirement_id"],
        "priority": row["source_priority_candidate"],
        "page": int(row["source_pdf_page"]),
        "table": int(row["source_table_index_on_page"]),
        "row": int(row["source_row_index_in_table"]),
        "wording_sha256": row["extracted_text_sha256"],
        "status": row["extraction_status"],
    } for row in v21_rows_raw]
    v21_by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in v21_rows:
        v21_by[row["id"]].append(row)
    if len(v21_by) != 849:
        raise ValueError("v2.1 full-PDF distinct candidate ID count mismatch")

    if v21_delta_ledger.get("sourceArtifactSha256") != v21_hash:
        raise ValueError("Official v2.1 delta ledger source SHA mismatch")
    official_rows = v21_delta_ledger.get("rows")
    if not isinstance(official_rows, list) or len(official_rows) != 50:
        raise ValueError("Official v2.1 delta ledger must contain exactly 50 rows")
    v21_delta_by: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in official_rows:
        if not isinstance(row, list) or len(row) != 6:
            raise ValueError("Unexpected official v2.1 delta row schema")
        rid, priority, page, table, row_index, wording_hash = row
        v21_delta_by[rid].append({
            "pdf_page": int(page), "table_index": int(table), "row_index": int(row_index),
            "priority_candidate": priority, "normalized_wording_sha256": wording_hash,
        })
    if set(v21_delta_by) != V21_DELTA_IDS:
        raise ValueError("Official v2.1 delta ledger ID set mismatch")
    full_pdf_delta_by = {row["id"]: row for row in v21_rows if row["id"] in V21_DELTA_IDS}
    delta_conflicts = []
    for row in official_rows:
        rid, priority, page, _table, _row_index, wording_hash = row
        extracted = full_pdf_delta_by.get(rid)
        if not extracted or (priority, int(page), wording_hash) != (
            extracted["priority"], extracted["page"], extracted["wording_sha256"]
        ):
            delta_conflicts.append(rid)
    if delta_conflicts:
        raise ValueError("v2.1 full-PDF candidate CSV and official delta ledger differ: " + ", ".join(sorted(delta_conflicts)))
    delta_priority_counts = Counter(
        item["priority_candidate"] for group in v21_delta_by.values() for item in group
    )
    if delta_priority_counts != Counter({"P0": 35, "P1": 15}):
        raise ValueError("v2.1 delta priority buckets mismatch")

    v21_inherited_by = {rid: group for rid, group in v21_by.items() if rid not in V21_DELTA_IDS}
    if sum(len(group) for group in v21_inherited_by.values()) != 807 or len(v21_inherited_by) != 799:
        raise ValueError("v2.1 inherited candidate population mismatch")

    exception_rows = read_csv(args.exception_decision_register)
    exception_meta = {row["requirementId"]: row for row in exception_rows}
    exception_ids = set(exception_meta)
    if len(exception_rows) != 37 or len(exception_ids) != 37:
        raise ValueError("Expected exactly 37 distinct priority/source exception decisions")
    if any(row.get("sourceOwnerDisposition") != "OPEN_SOURCE_OWNER_REVIEW" for row in exception_rows):
        raise ValueError("An exception row is not OPEN_SOURCE_OWNER_REVIEW")
    if any(row.get("machineAssessmentCandidate") not in MACHINE_CANDIDATES for row in exception_rows):
        raise ValueError("An exception machine assessment is missing or unrecognized")
    if any(str(row.get(field, "")).strip() for row in exception_rows for field in UNAPPROVED_FIELDS):
        raise ValueError("Exception register contains an unverified owner decision/approval value")
    machine_counts = Counter(row["machineAssessmentCandidate"] for row in exception_rows)
    if machine_counts != Counter({
        "CROSS_REFERENCE_CANDIDATE": 31,
        "HISTORY_REFERENCE_CANDIDATE": 3,
        "KPI_REFERENCE_CANDIDATE": 3,
    }):
        raise ValueError("Exception machine-assessment population changed; owner review required")

    closure = read_json(args.closure_register)
    closure_rows = closure.get("rows", [])
    if len(closure_rows) != 842:
        raise ValueError("Provisional closure register row count mismatch")
    closure_review_ids = {
        row.get("requirementId") for row in closure_rows
        if row.get("sourcePriority") == "REVIEW SOURCE"
    }
    if closure_review_ids != exception_ids or len(closure_review_ids) != 37:
        raise ValueError("37 exception IDs do not match closure tracker REVIEW SOURCE subset")

    v19_priority_conflicts = []
    for row in v19_rows:
        rid = row["requirementId"]
        expected = {row["priority"]}
        v20_priorities = {
            item["priority_candidate"] for item in v20_by.get(rid, [])
            if item["priority_candidate"]
        }
        v21_priorities = {
            item["priority"] for item in v21_inherited_by.get(rid, [])
            if item["priority"]
        }
        if expected != v20_priorities or expected != v21_priorities:
            v19_priority_conflicts.append(rid)
    if v19_priority_conflicts:
        raise ValueError("v1.9 priority differs from inherited candidates: " + ", ".join(sorted(set(v19_priority_conflicts))))

    v20_ids, v21_inherited_ids = set(v20_by), set(v21_inherited_by)
    if v20_ids != v21_inherited_ids:
        raise ValueError("v2.0 and v2.1 inherited candidate ID sets differ")
    if not v19_ids.issubset(v20_ids) or not v19_ids.issubset(v21_inherited_ids):
        raise ValueError("Some v1.9 growth-delta IDs do not match inherited candidate sets")
    if exception_ids & (v20_ids | v19_ids | set(v21_by)):
        raise ValueError("A priority exception unexpectedly appears in a normative/delta candidate population")

    rows = []
    priority_conflicts = []
    hash_equal = 0
    hash_different = []
    occurrence_count_deltas = []
    all_ids = sorted(v20_ids | set(v21_by) | v19_ids | exception_ids)
    for rid in all_ids:
        v20_group = v20_by.get(rid, [])
        v19_group = v19_by.get(rid, [])
        v21_group = v21_by.get(rid, [])
        v21_delta_group = v21_delta_by.get(rid, [])
        if v20_group and v21_group:
            priorities20 = {row["priority_candidate"] for row in v20_group if row["priority_candidate"]}
            priorities21 = {row["priority"] for row in v21_group if row["priority"]}
            priority_status = "PRIORITY_MATCH" if priorities20 == priorities21 else "PRIORITY_CONFLICT_REVIEW_REQUIRED"
            if priority_status != "PRIORITY_MATCH":
                priority_conflicts.append(rid)
            hashes20 = {row["normalized_wording_sha256"] for row in v20_group if row["normalized_wording_sha256"]}
            hashes21 = {row["wording_sha256"] for row in v21_group if row["wording_sha256"]}
            if hashes20 == hashes21:
                wording_status = "HASH_SET_MATCH"
                hash_equal += 1
            else:
                wording_status = "HASH_DIFFERENCE_REVIEW_REQUIRED"
                hash_different.append(rid)
            occurrence_delta = len(v21_group) - len(v20_group)
            if occurrence_delta:
                occurrence_count_deltas.append([rid, len(v20_group), len(v21_group)])
        else:
            priority_status = "NOT_COMPARABLE"
            wording_status = "NOT_COMPARABLE"
            occurrence_delta = None

        exception = exception_meta.get(rid)
        if rid in v20_ids and rid in v21_inherited_ids:
            lineage = "V20_V21_INHERITED_ID_MATCH_CANDIDATE"
        elif rid in V21_DELTA_IDS:
            lineage = "V21_NEW_DELTA_ID_CANDIDATE"
        elif exception:
            lineage = "PRIORITY_EXCEPTION_NOT_IN_NORMATIVE_TABLE_CANDIDATES"
        else:
            lineage = "OTHER_SOURCE_CANDIDATE"
        rows.append([
            rid,
            [[x["pdf_page"], x["table_index"], x["row_index"], x["priority_candidate"], x["normalized_wording_sha256"]] for x in v20_group],
            [[x["pdf_page"], x["text_line"], x["priority_candidate"]] for x in v19_group],
            [[x["page"], x["table"], x["row"], x["priority"], x["wording_sha256"]] for x in v21_group],
            [[x["pdf_page"], x["table_index"], x["row_index"], x["priority_candidate"], x["normalized_wording_sha256"]] for x in v21_delta_group],
            occurrence_delta,
            priority_status,
            wording_status,
            bool(exception),
            exception.get("machineAssessmentCandidate") if exception else None,
            "OPEN_SOURCE_OWNER_REVIEW" if exception else None,
            lineage,
        ])

    if len(rows) != 886 or len(priority_conflicts) != 0 or hash_equal != 754 or len(hash_different) != 45:
        raise ValueError("Crosswalk population or comparison contract mismatch")
    repeat_v20 = {rid: len(group) for rid, group in sorted(v20_by.items()) if len(group) > 1}
    repeat_v21 = {rid: len(group) for rid, group in sorted(v21_inherited_by.items()) if len(group) > 1}
    if len(repeat_v20) != 10 or len(repeat_v21) != 8:
        raise ValueError("Repeated occurrence candidate set changed")
    v19_priority_counts = Counter(row["priority"] for row in v19_rows)

    summary = {
        "unique_crosswalk_id_count": len(rows),
        "v20_normative_occurrence_count": len(v20_normative),
        "v20_distinct_normative_id_count": len(v20_ids),
        "v20_priority_counts": dict(Counter(row["source_priority_candidate"] for row in v20_normative)),
        "v20_repeated_normative_ids": repeat_v20,
        "v19_growth_delta_occurrence_count": len(v19_rows),
        "v19_growth_delta_distinct_id_count": len(v19_ids),
        "v19_priority_counts": dict(v19_priority_counts),
        "v19_ids_found_in_v20": len(v19_ids & v20_ids),
        "v19_ids_found_in_v21_inherited": len(v19_ids & v21_inherited_ids),
        "v19_priority_comparison_count": len(v19_rows),
        "v19_priority_conflict_count": len(v19_priority_conflicts),
        "v21_full_table_occurrences": len(v21_rows),
        "v21_full_table_distinct_ids": len(v21_by),
        "v21_inherited_occurrences": sum(len(group) for group in v21_inherited_by.values()),
        "v21_inherited_distinct_ids": len(v21_inherited_ids),
        "v20_v21_inherited_id_intersection": len(v20_ids & v21_inherited_ids),
        "v20_only_ids": len(v20_ids - v21_inherited_ids),
        "v21_inherited_only_ids": len(v21_inherited_ids - v20_ids),
        "v20_v21_priority_conflict_count": len(priority_conflicts),
        "v20_v21_wording_hash_equal_id_count": hash_equal,
        "v20_v21_wording_hash_different_id_count": len(hash_different),
        "v20_v21_wording_hash_difference_review_ids": sorted(hash_different),
        "v20_v21_occurrence_count_delta_ids": occurrence_count_deltas,
        "v21_official_delta_vs_full_pdf_conflict_count": len(delta_conflicts),
        "v21_new_delta_rows": len(v21_delta_by),
        "v21_new_delta_distinct_ids": len(v21_delta_by),
        "v21_new_delta_priority_counts": dict(delta_priority_counts),
        "v21_new_delta_ids_found_in_v20_inherited": len(V21_DELTA_IDS & v20_ids),
        "priority_exception_count": len(exception_ids),
        "priority_exceptions_in_v20_normative_rows": len(exception_ids & v20_ids),
        "priority_exceptions_in_v21_normative_rows": len(exception_ids & set(v21_by)),
        "priority_exceptions_in_v19_delta_rows": len(exception_ids & v19_ids),
        "priority_exception_machine_assessment_counts": dict(machine_counts),
        "provisional_closure_tracker_rows": len(closure_rows),
        "provisional_closure_tracker_known_p0_p1_rows": closure["policy"]["knownPriorityGateRows"],
        "provisional_closure_tracker_review_source_rows": len(closure_review_ids),
        "closure_tracker_review_source_ids_equal_exception_register_ids": True,
        "closure_tracker_review_source_ids": sorted(closure_review_ids),
        "all_active_scope_and_canonical_classifications_unresolved": True,
    }

    result = {
        "schema_version": 1,
        "crosswalk_id": "FOS-SRS-REVISION-OCCURRENCE-CROSSWALK-01",
        "prepared_date": "2026-11-04",
        "row_schema": [
            "requirement_id_candidate",
            "v20_occurrences_page_table_row_priority_wording_sha256",
            "v19_growth_delta_occurrences_page_line_priority",
            "v21_full_pdf_occurrences_page_table_row_priority_wording_sha256",
            "v21_delta_official_ledger_page_table_row_priority_wording_sha256",
            "v21_minus_v20_inherited_occurrence_count_delta",
            "v20_v21_priority_comparison",
            "v20_v21_wording_hash_comparison",
            "is_priority_exception",
            "exception_machine_assessment_candidate",
            "exception_owner_disposition",
            "lineage_candidate",
        ],
        "sources": {
            "srs_v20_candidate": {
                "filename": "FactoryOS_AI_-_SRS_v2_0_Clean_AI_Logic_Consolidated_SRS.pdf",
                "sha256": v20_hash, "pdf_pages": v20_pages,
                "source_identity_status": "CONFLICTED_DRAFT_CANDIDATE",
            },
            "srs_v19_growth_delta": {
                "filename": "FactoryOS_AI_-_SRS_v1_9_Client_Business_Growth_Research_Learning_AI.pdf",
                "sha256": v19_hash, "pdf_pages": v19_pages,
                "source_identity_status": "VERSION_METADATA_CONFLICT_REVIEW_OPEN",
            },
            "srs_v21_final_candidate": {
                "filename": "FactoryOS_AI_-_SRS_v2_1_FINAL_Product_Ready_Manufacturing_SaaS(2).pdf",
                "sha256": v21_hash, "pdf_pages": v21_pages,
                "source_identity_status": "SOURCE_BYTES_HASH_MATCHED_CONTROLLED_APPROVAL_PENDING",
            },
        },
        "declared_scope_claim": {
            "inherited_v20": 900, "v21_delta": 50, "cumulative": 950,
            "cumulative_priority": {"P0": 296, "P1": 582, "P2": 72},
            "status": "SOURCE_DECLARED_ARITHMETIC_NOT_ROW_LEVEL_ACCEPTANCE",
        },
        "derived_input_artifacts": {
            "v21_full_pdf_candidate_csv": {
                "sha256": V21_CSV_SHA256, "rows": 857,
                "generated_from_source_sha256": v21_hash,
            },
            "v21_delta_ledger": {
                "repository_path": "docs/srs-v21-delta-occurrence-ledger.json", "rows": 50,
            },
            "exception_owner_decision_register": {
                "repository_path": "docs/srs-priority-exception-owner-decision-register.csv",
                "rows": 37, "all_open": True,
            },
            "closure_register_json": {
                "repository_path": "docs/srs-p0-p1-evidence-closure-register.json", "rows": 842,
            },
        },
        "summary": summary,
        "acceptance_boundary": (
            "This is a source-candidate crosswalk, not an owner-approved active-scope ledger. "
            "It demonstrates identity intersections, occurrence counts, priority consistency and "
            "wording-hash review signals across available candidate sources. It does not prove 900 "
            "active inherited v2.0 normative occurrences or certify 950 active v2.1 occurrences. "
            "The 37 exception rows remain OPEN_SOURCE_OWNER_REVIEW. No canonical, active, superseded, "
            "duplicate, excluded or PASS decision is inferred."
        ),
        "rows": rows,
    }
    raw = (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    payload = base64.b64encode(compressed).decode("ascii")
    manifest = {
        "schema_version": 1,
        "crosswalk_id": result["crosswalk_id"],
        "encoding": "gzip+base64",
        "uncompressed_bytes": len(raw),
        "uncompressed_sha256": hashlib.sha256(raw).hexdigest(),
        "compressed_bytes": len(compressed),
        "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
        "row_count": len(rows),
        "source_hashes": {key: value["sha256"] for key, value in result["sources"].items()},
        "v21_candidate_csv_sha256": V21_CSV_SHA256,
        "derived_input_paths": {
            "v21_delta_ledger": "docs/srs-v21-delta-occurrence-ledger.json",
            "exception_owner_decision_register": "docs/srs-priority-exception-owner-decision-register.csv",
            "closure_register": "docs/srs-p0-p1-evidence-closure-register.json",
        },
        "summary": summary,
    }
    return result, {"raw": raw, "payload": payload, "manifest": manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v20-ledger", required=True, type=Path)
    parser.add_argument("--v19-ledger", required=True, type=Path)
    parser.add_argument("--v21-candidates-csv", required=True, type=Path)
    parser.add_argument("--v21-delta-ledger", required=True, type=Path)
    parser.add_argument("--exception-decision-register", required=True, type=Path)
    parser.add_argument("--closure-register", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--output-payload", required=True, type=Path)
    parser.add_argument("--output-manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        result, bundle = build(args)
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_bytes(bundle["raw"])
        args.output_payload.parent.mkdir(parents=True, exist_ok=True)
        args.output_payload.write_text(bundle["payload"] + "\n", encoding="ascii")
        args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
        args.output_manifest.write_text(
            json.dumps(bundle["manifest"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(
            f"PASS: {len(result['rows'])} crosswalk IDs; v2.0 809/799; "
            "v1.9 92/92 priorities match; v2.1 inherited 807/799 + official delta 50/50 match; "
            "exceptions 37/37 remain OPEN."
        )
        print("UNRESOLVED: 45 wording-hash differences and the declared 900/950 active occurrence acceptance remain open.")
        return 0
    except Exception as exc:  # noqa: BLE001 - fail closed on source drift or population mismatch.
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

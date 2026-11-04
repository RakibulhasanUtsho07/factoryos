#!/usr/bin/env python3
"""Synthetic regressions for the source-located SRS v2.0 candidate extractor."""
from __future__ import annotations
import unittest
from extract_srs_v20_inherited_occurrence_candidates import extract_page_candidates


class FakePage:
    height = 180
    def __init__(self, words):
        self.words = words
    def extract_words(self, extra_attrs=None):
        return list(self.words)


def word(text: str, x: float, y: float, *, bold: bool = False):
    return {
        "text": text, "x0": float(x), "x1": float(x + max(5, len(text) * 4)),
        "top": float(y), "bottom": float(y + 7),
        "size": 11.0 if bold else 7.0,
        "fontname": "LiberationSans-Bold" if bold else "LiberationSans",
    }


class SrsV20CandidateExtractorTests(unittest.TestCase):
    def test_requirement_schema_emits_locator_and_hash_without_wording(self):
        page = FakePage([
            word("ID", 10, 10, bold=True), word("Requirement", 45, 10, bold=True),
            word("Priority", 300, 10, bold=True), word("FR-OPS-01", 10, 32),
            word("System", 45, 32), word("shall", 72, 32), word("protect", 95, 32),
            word("P0", 300, 32),
        ])
        rows, unresolved, next_schema = extract_page_candidates(page, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["requirement_id_candidate"], "FR-OPS-01")
        self.assertEqual(rows[0]["table_kind_candidate"], "NORMATIVE_REQUIREMENT_TABLE")
        self.assertEqual(rows[0]["source_priority_candidate"], "P0")
        self.assertEqual(rows[0]["extraction_status"], "TABLE_ROW_CANDIDATE")
        self.assertEqual(rows[0]["occurrence_class"], "UNRESOLVED")
        self.assertIsNone(rows[0]["source_owner_decision_ref"])
        self.assertTrue(rows[0]["normalized_wording_sha256"])
        self.assertNotIn("System shall protect", str(rows[0]))
        self.assertEqual(unresolved, [])
        self.assertIsNotNone(next_schema)

    def test_agent_purpose_catalogue_is_not_normative(self):
        page = FakePage([
            word("ID", 10, 10, bold=True), word("Agent", 45, 10, bold=True),
            word("Purpose", 110, 10, bold=True), word("Priority", 300, 10, bold=True),
            word("FR-AGT-01", 10, 32), word("Planner", 45, 32),
            word("Plans", 110, 32), word("P1", 300, 32),
        ])
        rows, _, _ = extract_page_candidates(page, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["table_kind_candidate"], "AUXILIARY_CATALOGUE_TABLE")

    def test_repeated_id_occurrences_are_not_deduplicated(self):
        page = FakePage([
            word("ID", 10, 10, bold=True), word("Requirement", 45, 10, bold=True),
            word("Priority", 300, 10, bold=True),
            word("FR-OPS-01", 10, 32), word("Controls", 45, 32), word("P0", 300, 32),
            word("FR-OPS-01", 10, 62), word("Audits", 45, 62), word("P1", 300, 62),
        ])
        rows, _, _ = extract_page_candidates(page, 1)
        self.assertEqual(len(rows), 2)
        self.assertEqual([row["requirement_id_candidate"] for row in rows], ["FR-OPS-01", "FR-OPS-01"])
        self.assertNotEqual(rows[0]["source_occurrence_key"], rows[1]["source_occurrence_key"])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Synthetic contract tests for the SRS requirement occurrence extractor."""
from __future__ import annotations

import unittest

from extract_srs_requirement_occurrence_candidates import (
    extract_page_candidates,
    normalize_extracted_cell,
)


class FakePage:
    def __init__(self, words, height=180):
        self._words = words
        self.height = height

    def extract_words(self, extra_attrs=None):
        return list(self._words)


def word(text, x0, top, size=7.0, fontname="LiberationSans"):
    width = max(5.0, len(text) * 3.5)
    return {
        "text": text, "x0": float(x0), "x1": float(x0 + width),
        "top": float(top), "bottom": float(top + 7),
        "size": float(size), "fontname": fontname,
    }


def header(y=10):
    return [word("ID", 10, y, fontname="LiberationSans-Bold"),
            word("Requirement", 40, y, fontname="LiberationSans-Bold"),
            word("Priority", 120, y, fontname="LiberationSans-Bold")]


class OccurrenceExtractorTests(unittest.TestCase):
    def test_normalization_preserves_words_and_collapses_whitespace(self):
        words = [word("FactoryOS", 40, 20), word("SHALL", 70, 20), word("use", 90, 30)]
        self.assertEqual(normalize_extracted_cell(words), "FactoryOS SHALL use")

    def test_extracts_rows_with_locators_priorities_and_unresolved_disposition(self):
        words = header() + [
            word("Every", 40, 22), word("material", 60, 22), word("envelope.", 90, 22),
            word("FR-ABC-01", 10, 30), word("P0", 120, 30),
            word("Second", 40, 52), word("requirement.", 65, 52),
            word("FR-ABC-02", 10, 60), word("P1", 120, 60),
            word("3.", 5, 85, size=14.5, fontname="Carlito-Bold"),
            word("Next", 200, 85, size=14.5, fontname="Carlito-Bold"),
        ]
        rows, fragments = extract_page_candidates(FakePage(words), 1)
        self.assertEqual(fragments, [])
        self.assertEqual([row["requirement_id"] for row in rows], ["FR-ABC-01", "FR-ABC-02"])
        self.assertEqual([row["source_priority_candidate"] for row in rows], ["P0", "P1"])
        self.assertEqual(rows[0]["extracted_normative_text_candidate"], "Every material envelope.")
        self.assertEqual(rows[1]["extracted_normative_text_candidate"], "Second requirement.")
        self.assertEqual(len({row["source_occurrence_key"] for row in rows}), 2)
        self.assertTrue(all(row["occurrence_class"] == "UNRESOLVED" for row in rows))

    def test_keeps_page_boundary_tail_separate_from_current_row_prefix(self):
        words = header() + [
            word("previous", 40, 22), word("row", 70, 22), word("continuation.", 82, 22),
            word("A", 40, 32), word("current", 48, 32), word("requirement.", 74, 32),
            word("FR-ABC-03", 10, 40), word("P0", 120, 40),
        ]
        rows, fragments = extract_page_candidates(FakePage(words), 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["requirement_id"], "FR-ABC-03")
        self.assertEqual(rows[0]["extracted_normative_text_candidate"], "A current requirement.")
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["extracted_text"], "previous row continuation.")
        self.assertEqual(fragments[0]["disposition"], "UNRESOLVED_REVIEW_REQUIRED")

    def test_missing_priority_fails_closed(self):
        words = header() + [
            word("Unsafe", 40, 22), word("row.", 70, 22), word("FR-ABC-04", 10, 30)
        ]
        rows, _ = extract_page_candidates(FakePage(words), 1)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["source_priority_candidate"])
        self.assertEqual(rows[0]["extraction_status"], "PARTIAL_EXTRACTION_REVIEW_REQUIRED")
        self.assertEqual(rows[0]["occurrence_class"], "UNRESOLVED")


if __name__ == "__main__":
    unittest.main()

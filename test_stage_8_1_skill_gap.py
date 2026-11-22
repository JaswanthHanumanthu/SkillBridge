import sys
import types
import unittest
from unittest.mock import patch

from backend.resume_parser import MAX_RESUME_PARSE_BYTES, parse_resume_pdf, validate_pdf_upload
from backend.skill_matching import analyze_skill_gap, normalize_skill


class SkillGapTests(unittest.TestCase):
    def test_aliases_are_normalized_without_broad_equivalence(self):
        self.assertEqual(normalize_skill("JS"), normalize_skill("JavaScript"))
        self.assertEqual(normalize_skill("C Sharp"), normalize_skill("C#"))
        self.assertEqual(normalize_skill("CPP"), normalize_skill("C++"))
        self.assertEqual(normalize_skill("Postgres"), normalize_skill("PostgreSQL"))
        self.assertNotEqual(normalize_skill("Java"), normalize_skill("JavaScript"))

    def test_required_percentage_and_optional_skills(self):
        result = analyze_skill_gap(
            [{"name": "Java"}, {"name": "Python"}, {"name": "SQL"}, {"name": "React", "is_required": False}],
            ["java", "JS"],
        )
        self.assertEqual(result["total_required_skills"], 3)
        self.assertEqual(result["required_skill_match_percentage"], 33.3)
        self.assertEqual(result["matched_required_skills"], ["Java"])
        self.assertEqual(result["missing_required_skills"], ["Python", "SQL"])

    def test_empty_profile_and_empty_requirements(self):
        empty_profile = analyze_skill_gap([{"name": "Python"}], [])
        self.assertEqual(empty_profile["required_skill_match_percentage"], 0)
        self.assertIn("Add technical skills", empty_profile["skill_gap_message"])
        self.assertEqual(empty_profile["missing_required_skills"], ["Python"])
        no_requirements = analyze_skill_gap([{"name": "React", "is_required": False}], ["React"])
        self.assertIsNone(no_requirements["required_skill_match_percentage"])
        self.assertEqual(no_requirements["total_required_skills"], 0)

    def test_pdf_upload_validation(self):
        validate_pdf_upload("resume.pdf", "application/pdf", b"%PDF-1.4 sample")
        for filename, mime, payload in (
            ("resume.txt", "application/pdf", b"%PDF-1.4 sample"),
            ("resume.pdf", "text/plain", b"%PDF-1.4 sample"),
            ("resume.pdf", "application/pdf", b""),
        ):
            with self.subTest(filename=filename, mime=mime), self.assertRaises(ValueError):
                validate_pdf_upload(filename, mime, payload)
        with self.assertRaises(OverflowError):
            validate_pdf_upload("resume.pdf", "application/pdf", b"%PDF-" + b"0" * MAX_RESUME_PARSE_BYTES)

    def test_local_parser_returns_reviewable_values_and_catalog_skills(self):
        resume_text = """Asha Rao
asha@example.test
Phone: +91 98765 43210
Location: Bengaluru, India
Headline: Computer Science Student
Skills: JS and Postgres
Education
University: Example Institute
B.Tech in Computer Science 2026
"""

        class Page:
            def extract_text(self): return resume_text

        class Reader:
            is_encrypted = False
            pages = [Page()]
            def __init__(self, _stream, strict=False): pass

        fake_pypdf = types.SimpleNamespace(PdfReader=Reader)
        with patch.dict(sys.modules, {"pypdf": fake_pypdf}):
            result = parse_resume_pdf(b"%PDF-1.4 sample", [{"name": "JavaScript"}, {"name": "PostgreSQL"}])
        self.assertEqual(result["profile"]["full_name"], "Asha Rao")
        self.assertEqual(result["profile"]["email"], "asha@example.test")
        self.assertEqual(result["profile"]["location"], "Bengaluru, India")
        self.assertEqual(result["skills"], ["JavaScript", "PostgreSQL"])
        self.assertEqual(result["education"][0]["end_year"], 2026)


if __name__ == "__main__":
    unittest.main()

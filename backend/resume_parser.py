"""Conservative, local-only PDF text extraction for candidate profile autofill."""
from io import BytesIO
import re

MAX_RESUME_PARSE_BYTES = 5 * 1024 * 1024
MAX_PDF_PAGES = 20
MAX_EXTRACTED_CHARS = 160_000

_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d().\s-]{7,}\d)(?!\w)")
_YEAR_RE = re.compile(r"\b(?:19[5-9]\d|20[0-9]\d|2100)\b")
_DEGREE_RE = re.compile(r"\b(B\.?\s?Tech|B\.?\s?E\.?|B\.?\s?Sc\.?|M\.?\s?Tech|M\.?\s?E\.?|M\.?\s?Sc\.?|MCA|MBA|Ph\.?D\.?|Bachelor(?:'s)?|Master(?:'s)?)\b", re.I)
_SECTION_RE = re.compile(r"^(education|experience|work experience|skills|technical skills|projects|certifications|summary|profile|objective|achievements|contact|languages)\s*:?[\s]*$", re.I)


def validate_pdf_upload(filename, content_type, payload):
    if not filename or not filename.lower().endswith(".pdf"):
        raise ValueError("Choose a PDF file.")
    if (content_type or "").split(";", 1)[0].strip().lower() != "application/pdf":
        raise ValueError("The uploaded file must use the application/pdf MIME type.")
    if not payload:
        raise ValueError("The uploaded PDF is empty.")
    if len(payload) > MAX_RESUME_PARSE_BYTES:
        raise OverflowError("PDF resumes must be 5 MB or smaller.")
    if not payload.startswith(b"%PDF-"):
        raise ValueError("The file contents are not a valid PDF.")


def _clean_lines(text):
    lines = []
    for line in text.replace("\x00", " ").splitlines():
        line = re.sub(r"\s+", " ", line).strip(" \t|•·")
        if line:
            lines.append(line[:300])
    return lines


def _label_value(lines, labels):
    pattern = re.compile(r"^(?:" + "|".join(labels) + r")\s*[:\-]\s*(.+)$", re.I)
    for line in lines:
        match = pattern.match(line)
        if match:
            return match.group(1).strip()[:200]
    return None


def _extract_name(lines, email):
    explicit = _label_value(lines[:20], ["full name", "name"])
    if explicit:
        return explicit[:100]
    for line in lines[:8]:
        if _SECTION_RE.match(line) or "@" in line or any(ch.isdigit() for ch in line):
            continue
        if re.search(r"\b(developer|engineer|student|software|analyst|manager|specialist|designer|intern)\b", line, re.I):
            continue
        words = line.split()
        if 2 <= len(words) <= 5 and len(line) <= 70 and not re.search(r"\b(resume|curriculum vitae|portfolio)\b", line, re.I):
            return line[:100]
    return None


def _extract_education(lines):
    education = []
    edu_index = next((i for i, line in enumerate(lines) if re.match(r"^education\b", line, re.I)), None)
    if edu_index is None:
        return education
    section_end = next(
        (i for i in range(edu_index + 1, len(lines)) if _SECTION_RE.match(lines[i])),
        len(lines),
    )
    segment = lines[edu_index + 1:section_end]
    for i, line in enumerate(segment):
        degree_match = _DEGREE_RE.search(line)
        if not degree_match:
            continue
        degree = degree_match.group(0).replace("  ", " ").strip()
        field = None
        for separator in (" in ", " - ", " — ", ", "):
            if separator.lower() in line.lower():
                tail = re.split(re.escape(separator), line, maxsplit=1, flags=re.I)[-1]
                tail = _YEAR_RE.sub("", tail).strip(" ,-|—")
                if tail and normalize_candidate_text(tail) != normalize_candidate_text(degree):
                    field = tail[:150]
                    break
        year_match = _YEAR_RE.search(line)
        if not year_match and i + 1 < len(segment):
            year_match = _YEAR_RE.search(segment[i + 1])
        institution = _label_value(segment[max(0, i - 2):i + 1], ["institution", "university", "college"])
        row = {"institution": institution, "degree": degree[:150], "field_of_study": field,
               "start_year": None, "end_year": int(year_match.group(0)) if year_match else None, "grade": None}
        if row not in education:
            education.append(row)
        if len(education) == 3:
            break
    return education


def normalize_candidate_text(value):
    return re.sub(r"[^a-z0-9]", "", (value or "").casefold())


def _catalog_skills(text, catalog):
    found, seen = [], set()
    from backend.skill_matching import normalize_skill

    for item in catalog:
        name = item["name"] if isinstance(item, dict) else str(item)
        key = normalize_skill(name)
        if not key or (len(key) < 2 and key not in {"c#", "c++"}) or key in seen:
            continue
        aliases = [name]
        if key == "javascript": aliases.append("JS")
        elif key == "c#": aliases.append("C Sharp")
        elif key == "c++": aliases.append("CPP")
        elif key == "postgresql": aliases.append("Postgres")
        if any(re.search(r"(?<![A-Za-z0-9])" + re.escape(alias) + r"(?![A-Za-z0-9])", text, re.I) for alias in aliases):
            seen.add(key)
            found.append(name)
    return found[:60]


def parse_resume_pdf(payload, skill_catalog):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("Install the project requirements to enable PDF resume extraction.") from exc
    try:
        reader = PdfReader(BytesIO(payload), strict=False)
        if reader.is_encrypted:
            raise ValueError("Password-protected PDFs cannot be parsed. Upload an unlocked PDF.")
        if not reader.pages:
            raise ValueError("The PDF has no readable pages.")
        text_parts = []
        for page in reader.pages[:MAX_PDF_PAGES]:
            text_parts.append(page.extract_text() or "")
            if sum(map(len, text_parts)) > MAX_EXTRACTED_CHARS:
                raise ValueError("This PDF contains too much text to process safely.")
        text = "\n".join(text_parts)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("This PDF could not be read. Try exporting it again as a text-based PDF.") from exc

    lines = _clean_lines(text)
    if len("".join(lines)) < 25:
        raise ValueError("No readable text was found. Scanned image-only PDFs are not supported.")
    email_match = _EMAIL_RE.search(text)
    phone_match = _PHONE_RE.search(text)
    location = _label_value(lines, ["location", "based in", "city"])
    headline = _label_value(lines[:30], ["professional headline", "headline", "professional title"])
    profile = {
        "full_name": _extract_name(lines, email_match.group(0) if email_match else None),
        "email": email_match.group(0) if email_match else None,
        "phone": phone_match.group(0).strip() if phone_match else None,
        "location": location,
        "headline": headline,
    }
    education = _extract_education(lines)
    skills = _catalog_skills(text, skill_catalog)
    detected = [key for key, value in profile.items() if value]
    if skills: detected.append("skills")
    if education: detected.append("education")
    return {
        "profile": profile,
        "skills": skills,
        "education": education,
        "detected_fields": detected,
        "manual_fields": [key for key, value in profile.items() if not value],
        "notes": ["Resume text is processed locally for this request and is not stored by the profile autofill endpoint.",
                  "Review every extracted value before saving. Education rows without an institution are suggestions only."],
    }

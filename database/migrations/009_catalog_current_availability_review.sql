-- Stage 10 catalog review, verified 2026-11-22.
-- Retain prior curated rows for administrator/history review, but keep recurring
-- pathways and closed event cycles out of current student discovery until a new
-- open intake is confirmed. This only changes publication state; it deletes no rows.
BEGIN;

UPDATE jobs
SET status = 'draft'
WHERE owner_type = 'ADMIN'
  AND status = 'published'
  AND title = ANY (ARRAY[
      'Winternship — Infosys',
      'Elite Technical Graduate Hiring Program — Wipro',
      'Turbo Technical Hiring Program — Wipro',
      'STAR Technical Hiring Program — Wipro',
      'Integrated Learning Program (WILP / WASE / WIMS) — Wipro',
      'School of Infrastructure Management (SIM) — Wipro',
      'B-School Program — Wipro',
      'Summer Internship Experience (WiSE) — Wipro',
      'Step Up People Ambassador and Financial Analyst Program — Wipro',
      'Infosys Summer Internship — Management Graduates',
      'InStep Global Internship Program — Infosys',
      'Cisco Women Internship Program (CWIP) — India',
      'Code with Cisco — India (2027 Graduating Batch)'
  ]::TEXT[]);

COMMIT;

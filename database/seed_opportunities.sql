-- Repeatable catalog of clearly marked SkillBridge sample opportunities.
DO $$
DECLARE company_id INT; account_id INT; recruiter_id INT;
BEGIN
 INSERT INTO companies(name,description,industry,location,status)
 VALUES ('SkillBridge Demo Organization','Sample listings for demonstrating discovery and matching; not real openings.','Education Technology','India','approved')
 ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description RETURNING id INTO company_id;
 INSERT INTO accounts(username,password_hash,role)
 SELECT 'skillbridge_demo_recruiter', password_hash, 'recruiter' FROM accounts WHERE role='recruiter' ORDER BY id LIMIT 1
 ON CONFLICT(username) DO NOTHING;
 SELECT id INTO account_id FROM accounts WHERE username='skillbridge_demo_recruiter';
 INSERT INTO recruiter_profiles(account_id,company_id,full_name,email,designation)
 VALUES(account_id,company_id,'SkillBridge Demo Team','demo@skillbridge.invalid','Demo Catalog')
 ON CONFLICT(account_id) DO UPDATE SET company_id=EXCLUDED.company_id RETURNING id INTO recruiter_id;
 INSERT INTO jobs(company_id,recruiter_id,title,job_type,work_mode,location,description,requirements,salary_min,salary_max,deadline,status,opportunity_category,experience_level,paid_status,eligibility,start_date,duration,positions,source,is_sample,is_verified,demo_key)
 SELECT company_id,recruiter_id,
   domains.d || ' ' || cats.c || ' opportunity ' || lpad(n::text,3,'0'),
   CASE WHEN cats.c IN ('Internship','Research','Apprenticeship') THEN 'Internship' WHEN cats.c IN ('Part-time','Workshop') THEN 'Part-time' ELSE 'Full-time' END,
   CASE n%3 WHEN 0 THEN 'Remote' WHEN 1 THEN 'Hybrid' ELSE 'On-site' END,
   CASE n%6 WHEN 0 THEN 'Remote, India' WHEN 1 THEN 'Bengaluru' WHEN 2 THEN 'Mumbai' WHEN 3 THEN 'Pune' WHEN 4 THEN 'Hyderabad' ELSE 'Delhi' END,
   'DEMO SAMPLE — This fictional listing is provided only to demonstrate SkillBridge discovery and personalized matching. No real organization or opening is represented.',
   'Sample eligibility: current students and recent graduates; see listing details.',
   CASE WHEN n%4=0 THEN 0 ELSE 10000 END, CASE WHEN n%4=0 THEN 0 ELSE 50000 END,
   CURRENT_DATE + (15 + (n%75)) * INTERVAL '1 day','published', cats.k,
   (ARRAY['Beginner','Intermediate','Advanced','Student','Fresher'])[1+(n%5)],
   (ARRAY['paid','unpaid','stipend','prize','none'])[1+(n%5)],
   'Students, freshers, or early-career applicants; fictional demo eligibility.',
   CURRENT_DATE + INTERVAL '30 days', (1+(n%6))::text || ' months', 1+(n%10), 'SkillBridge sample data', TRUE, FALSE, 'demo-'||lpad(n::text,3,'0')
 FROM generate_series(1,90) n
 CROSS JOIN LATERAL (SELECT (ARRAY['Java','Python','C++','JavaScript','React','Node.js','SQL','PostgreSQL','Data Structures','Machine Learning','AI','Data Analytics','Web Development','Backend Development','Frontend Development','Cloud Computing','Cybersecurity','DevOps','Mobile Development','UI/UX'])[1+((n-1)%20)] AS d) domains
 CROSS JOIN LATERAL (SELECT c,k FROM (VALUES ('Internship','internship'),('Hackathon','hackathon'),('Student Project','project'),('Open Source','open_source'),('Research','research'),('Scholarship','scholarship'),('Fellowship','fellowship'),('Coding Competition','competition'),('Workshop','workshop'),('Developer Program','developer_program'),('Startup','startup'),('Apprenticeship','apprenticeship'),('Certification','certification'),('Full-time','job'),('Part-time','job')) t(c,k) ORDER BY c OFFSET ((n-1)%15) LIMIT 1) cats
 ON CONFLICT(demo_key) WHERE demo_key IS NOT NULL DO NOTHING;
 INSERT INTO job_skills(job_id,skill_id,is_required,min_proficiency)
 SELECT j.id,s.id,TRUE,'Beginner' FROM jobs j
 JOIN skills s ON lower(s.name)=lower(split_part(j.title,' ',1))
 WHERE j.demo_key LIKE 'demo-%' ON CONFLICT(job_id,skill_id) DO NOTHING;
END $$;

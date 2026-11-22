-- Idempotent, additive seed of currently open hackathons researched on 2026-11-22.
-- No existing opportunity is updated or removed. Run with psql -v ON_ERROR_STOP=1.
BEGIN;

SELECT pg_advisory_xact_lock(hashtext('skillbridge-hackathon-seed-2026-11-22'));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name='hackathon_details') THEN
        RAISE EXCEPTION 'Required migration 011_hackathon_event_details.sql is not applied.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE role='developer') THEN
        RAISE EXCEPTION 'A platform administrator account is required before importing curated opportunities.';
    END IF;
END $$;

WITH admin AS (
    SELECT id FROM accounts WHERE role='developer' ORDER BY id LIMIT 1
), seed(
    title, organizer, location, mode, description, eligibility, deadline, event_start, event_end,
    team_min, team_max, individual, themes, tracks, prize_pool, source_classification, source_url, registration_url
) AS (
    VALUES
    (
        'SciX India Hackathon', 'SciX', 'Online · India', 'Online',
        'Free national STEAM-student hackathon covering engineering, pharma, biotech and chemical technology. The active ideation stage accepts 6–8 slide project submissions; a prototype stage follows.',
        'STEAM students in engineering, pharma, biotech and chemical technology; teams of 1–4 or individual participation.',
        DATE '2026-11-30', DATE '2026-10-18', DATE '2027-01-05', 1, 4, TRUE,
        'Engineering, Pharma, Biotech, Chemical Technology', 'Ideation and team building; prototype', '₹30,000 cash prizes',
        'ADMIN_CURATED_VERIFIED', 'https://scix.in/hackathons/c80a5324-5054-48c2-b187-258e471aa5b1',
        'https://scix.in/hackathons/c80a5324-5054-48c2-b187-258e471aa5b1'
    ),
    (
        'Rack It Up 2026', 'Rack''Em × Karma Enterprises', 'Online · India', 'Online',
        'Free 48-hour online hackathon for developers and students across India. Build and deploy a working project. Themes include AI for everyday India, student life and learning, local business, developer tools and open innovation.',
        'Developers and students across India; solo or teams of 1–4. Registration closes 8 December 2026 at 7 PM IST.',
        DATE '2026-12-08', DATE '2026-12-11', DATE '2026-12-13', 1, 4, TRUE,
        'AI for Everyday India, Student Life & Learning, Local Business & Commerce, Developer Tools & Infra, Open Innovation', 'Open innovation', NULL,
        'ADMIN_CURATED_VERIFIED', 'https://rackitup.karmaenterprises.tech/',
        'https://unstop.com/hackathons/rack-it-up-2026-48-hour-online-hackathon-by-rackem-karma-enterprises-1777639'
    ),
    (
        'LearningPanda National AI Agents Hackathon 2026', 'LearningPanda', 'Online · India', 'Online',
        'Free week-long student hackathon to build an AI agent that improves learning, such as a tutor, study planner, doubt solver or grader. Organizer states prizes and benefits are still to be announced.',
        'College and university students enrolled in India, age 18+; teams of 2–4, inter-college teams allowed.',
        DATE '2026-12-15', DATE '2026-12-18', DATE '2026-12-25', 2, 4, FALSE,
        'Open innovation; AI agents for education', 'AI agents, education technology', NULL,
        'ADMIN_CURATED_VERIFIED', 'https://www.learningpanda.ai/hackathon',
        'https://www.learningpanda.ai/login?next=%2Fdashboard%2Fhackathon%2Flearningpanda-national-ai-agents-hackathon-2026&track=technology'
    ),
    (
        'Infer-a-thon with Superlinked', 'Geek Room × Superlinked', 'Online · Worldwide', 'Online',
        'Seven-day global agentic AI hackathon. Tracks cover agentic business workflows in India and agentic engineering. Official event details and problem statements are scheduled to be released on 5 December 2026.',
        'Developers, AI engineers, founders, professionals, interns and enthusiasts worldwide; solo or teams of 1–4.',
        DATE '2026-12-05', DATE '2026-12-05', DATE '2026-12-20', 1, 4, TRUE,
        'Agentic AI, business workflows, agentic engineering', 'Agentic Businesses in India, Agentic Engineering', '₹1.5 lakh+ prize pool',
        'ADMIN_CURATED_VERIFIED', 'https://www.geekroom.co.in/event/infer-a-thon',
        'https://luma.com/f7ef30j2'
    ),
    (
        'Hackoverflow-2k26', 'SRKR Coding Club', 'Bhimavaram, Andhra Pradesh, India', 'Offline',
        'National-level 24-hour hackathon hosted at Sagi Rama Krishnam Raju Engineering College. An online idea review precedes the offline final. The organizer lists team fees and a ₹60,000 prize pool.',
        'Students; teams of 4–6. Registration closes 30 November 2026 at 11:59 PM IST. Round 1 fee ₹200 per team; shortlisted final participation fee ₹850 per person.',
        DATE '2026-11-30', DATE '2026-12-18', DATE '2026-12-19', 4, 6, FALSE,
        'App/Web Development, AI/ML, Cybersecurity, Blockchain, IoT', 'Open innovation', '₹60,000',
        'ADMIN_CURATED_VERIFIED', 'https://www.srkrcodingclub.in/hackathons/hackoverflow-2k26',
        'https://www.srkrcodingclub.in/hackathons/hackoverflow-2k26/dashboard'
    ),
    (
        'ML Challenge (AI/ML Datathon)', 'Hack4Hack', 'Online · Worldwide', 'Online',
        'Online machine-learning datathon with two 24-hour rounds using real datasets and a live leaderboard. Registration and Round 1 are free; teams qualifying for Round 2 pay ₹299 per team in India or US$10 outside India.',
        'College students and working professionals worldwide; solo or teams of 1–4.',
        DATE '2026-12-02', DATE '2026-12-03', DATE '2026-12-09', 1, 4, TRUE,
        'AI / ML, machine learning', 'Two 24-hour dataset rounds', '₹1,00,000',
        'ADMIN_CURATED_PROGRAM', 'https://hack4hack.com/hackathons/ml-challenge-qg4o',
        'https://hack4hack.com/hackathons/ml-challenge-qg4o'
    ),
    (
        'Buildathon 1.0', 'Buildathon 1.0', 'Online · Worldwide', 'Online',
        'Online two-round buildathon. Round 1 is a free idea deck submission; shortlisted teams build for eight hours on 12 December and present online on 13 December. Shortlisted teams pay ₹600 per team to confirm their finale place.',
        'Students, freshers and professionals; teams of 2–4. Registration and Round 1 are free; finalist fee applies only to shortlisted teams.',
        DATE '2026-12-06', DATE '2026-11-13', DATE '2026-12-15', 2, 4, FALSE,
        'Open Innovation, Generative AI, AI/ML, HealthTech, FinTech, EdTech, Sustainability, AgriTech, Smart Cities', 'Buildathon, idea deck, 8-hour finale', '₹50,000 + $100 Claude Code credits for each of top 3 teams',
        'ADMIN_CURATED_PROGRAM', 'https://hack4hack.com/hackathons/buildathon-1-0-7ruu',
        'https://hack4hack.com/hackathons/buildathon-1-0-7ruu'
    ),
    (
        'NovaStark Hacks 2026', 'NovaStark Hacks', 'Online · India', 'Online',
        'National student software and AI hackathon with free online submission, mentorship/selection and an online live-pitch finale. Shortlisted teams pay a ₹1,499 per-squad finalist slot and evaluation fee.',
        'UG, PG and diploma students in recognized institutions across India; teams of 2–4. Round 1 is free.',
        DATE '2026-12-07', DATE '2026-11-01', DATE '2026-12-21', 2, 4, FALSE,
        'AI/ML, Generative AI, HealthTech, FinTech, Sustainability, Smart Cities, Open Innovation', 'Online submission, online live pitch', '₹2,70,000+',
        'ADMIN_CURATED_PROGRAM', 'https://hack4hack.com/hackathons/novastark-hacks-2026-5thd',
        'https://hack4hack.com/hackathons/novastark-hacks-2026-5thd'
    ),
    (
        'ChainShift 2026: Web3 Hackathon', 'Hack4Hack', 'Online · Worldwide', 'Online',
        'Online Web3 hackathon focused on on-chain apps for public testnets. Round 1 idea submission is free; selected teams pay $10 / ₹999 per team to confirm a Round 2 build slot.',
        'College students and working professionals worldwide; teams of 2–4.',
        DATE '2026-12-16', DATE '2026-11-15', DATE '2026-12-30', 2, 4, FALSE,
        'Web3, FinTech, identity and credentials', 'Public testnet on-chain applications', '$1,500',
        'ADMIN_CURATED_PROGRAM', 'https://hack4hack.com/hackathons/chainshift-2026-web3-hackathon-dbx6',
        'https://hack4hack.com/hackathons/chainshift-2026-web3-hackathon-dbx6'
    )
)
INSERT INTO jobs (
    company_id,recruiter_id,owner_type,created_by_admin,organization_name,
    title,job_type,opportunity_type,work_mode,location,description,requirements,
    salary_min,salary_max,deadline,start_date,status,opportunity_category,experience_level,
    paid_status,eligibility,application_url,application_mode,positions,source,
    source_classification,source_url,source_verified_by,source_verified_at,
    is_verified,is_sample,eligible_branches,hackathon_details
)
SELECT
    NULL,NULL,'ADMIN',admin.id,seed.organizer,
    seed.title,NULL,'hackathon',
    CASE seed.mode WHEN 'Online' THEN 'Remote' WHEN 'Offline' THEN 'On-site' ELSE 'Hybrid' END,
    seed.location,seed.description,seed.eligibility,
    0,0,seed.deadline,seed.event_start,'published','hackathon','Student',
    CASE WHEN seed.prize_pool IS NULL THEN 'none' ELSE 'prize' END,seed.eligibility,
    seed.registration_url,'external',NULL,'admin_curated',
    seed.source_classification,seed.source_url,
    CASE WHEN seed.source_classification='ADMIN_CURATED_VERIFIED' THEN admin.id ELSE NULL END,
    CASE WHEN seed.source_classification='ADMIN_CURATED_VERIFIED' THEN CURRENT_TIMESTAMP ELSE NULL END,
    seed.source_classification='ADMIN_CURATED_VERIFIED',FALSE,'{}'::text[],
    jsonb_strip_nulls(jsonb_build_object(
        'organizer_type','Organizer', 'event_mode',seed.mode,
        'country',CASE WHEN seed.location ILIKE '%India%' THEN 'India' WHEN seed.location ILIKE '%worldwide%' THEN 'Worldwide' END,
        'city',CASE WHEN seed.location ILIKE '%Bhimavaram%' THEN 'Bhimavaram' END,
        'state',CASE WHEN seed.location ILIKE '%Andhra Pradesh%' THEN 'Andhra Pradesh' END,
        'themes',seed.themes,'tracks',seed.tracks,'prize_pool',seed.prize_pool,
        'registration_open_date',CASE seed.title
            WHEN 'SciX India Hackathon' THEN '2026-10-18'
            WHEN 'Rack It Up 2026' THEN '2026-10-30'
            WHEN 'LearningPanda National AI Agents Hackathon 2026' THEN '2026-11-18'
            WHEN 'Hackoverflow-2k26' THEN '2026-10-24'
            WHEN 'ML Challenge (AI/ML Datathon)' THEN '2026-11-07'
            WHEN 'Buildathon 1.0' THEN '2026-11-13'
            WHEN 'NovaStark Hacks 2026' THEN '2026-10-25'
            WHEN 'ChainShift 2026: Web3 Hackathon' THEN '2026-11-15'
        END,
        'event_start_date',to_char(seed.event_start,'YYYY-MM-DD'),
        'event_end_date',to_char(seed.event_end,'YYYY-MM-DD'),
        'team_size_min',seed.team_min,'team_size_max',seed.team_max,
        'individual_allowed',seed.individual,'certificates',NULL,
        'prize_details',CASE WHEN seed.title='Buildathon 1.0' THEN 'Top three teams receive $100 Claude Code credits each. Round 1 is free; ₹600 per team finalist fee applies to shortlisted teams.' WHEN seed.title='NovaStark Hacks 2026' THEN 'Round 1 is free. Shortlisted teams pay ₹1,499 per squad finalist slot and evaluation fee.' WHEN seed.title='ChainShift 2026: Web3 Hackathon' THEN 'Round 1 is free; selected Round 2 teams pay $10 (₹999) per team.' WHEN seed.title='ML Challenge (AI/ML Datathon)' THEN 'Registration and Round 1 are free; Round 2 qualifying teams pay ₹299 per team in India or US$10 outside India.' WHEN seed.title='Hackoverflow-2k26' THEN 'Round 1 fee ₹200 per team; shortlisted final participation fee ₹850 per person.' END,
        'last_verified_at',CURRENT_TIMESTAMP,
        'organizer_website_url',seed.source_url
    ))
FROM seed CROSS JOIN admin
WHERE NOT EXISTS (
    SELECT 1 FROM jobs existing
    WHERE existing.opportunity_category='hackathon'
      AND (existing.source_url=seed.source_url OR
           (lower(existing.title)=lower(seed.title) AND lower(COALESCE(existing.organization_name,''))=lower(seed.organizer)))
);

COMMIT;

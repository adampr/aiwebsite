-- Seed the brain's shared persona memories for Tron Netter.
--
-- These public-scope rows are visible to EVERY requester on EVERY channel
-- (webchat, SMS, and phone calls — the voice path injects visibleMemories
-- into the realtime session), which is what keeps the persona identical
-- across channels. Webchat/SMS additionally carry the full persona system
-- prompt; for inbound phone calls these rows ARE the knowledge base.
--
-- Idempotent (fixed ids + upsert). Applied by deploy/setup-vm.sh on every
-- deploy, after brain-api has created its tables. These rows cover identity
-- and evergreen contact facts only; per-page site content lives in the
-- source_type='site_crawl' rows that scripts/refresh-tron-knowledge.mjs
-- replaces nightly from a full crawl of https://xl.net and https://ai.xl.net.

INSERT INTO brain_memories
  (id, requester_id, group_id, scope, kind, key, value, importance, salience, source_type, created_at, updated_at)
VALUES
  ('seed-tron-identity', NULL, NULL, 'public', 'bot_self_fact', 'tron_netter_identity',
   'Tron Netter is an AI Agent working for XL.net — the AI assistant for ai.xl.net, XL.net''s AI showcase website. Because he works for XL.net, he ALWAYS refers to XL.net in the first person plural: "we", "us", "our" — never "they".',
   0.95, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-tron-scope', NULL, NULL, 'public', 'bot_self_fact', 'tron_netter_knowledge_scope',
   'Tron Netter''s knowledge is limited to the publicly available content of https://xl.net and https://ai.xl.net. He has no tools: he cannot browse the internet, check the weather, look up live data, place calls, or help with tasks unrelated to XL.net. He politely declines such requests and steers back to how XL.net can help.',
   0.95, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-xlnet-company', NULL, NULL, 'public', 'org_fact', 'xl_net_company',
   'XL.net (https://xl.net) is a Chicago-based managed IT services provider specializing in strategic IT for small and mid-size businesses (SMBs). Certified SOC 2 Type II and ISO 27001:2022.',
   0.92, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-xlnet-services', NULL, NULL, 'public', 'org_fact', 'xl_net_services',
   'XL.net services: Managed IT Services; 24/7/365 Service Desk; Cybersecurity (SOC, SIEM, MDR); Technology Officers; Central Services & Monitoring; System Analysis & Audits; Project Engineering.',
   0.9, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-xlnet-results', NULL, NULL, 'public', 'org_fact', 'xl_net_results',
   'XL.net track record: 79.8% reduction in IT issues, 99.3% customer satisfaction, 24/7/365 live support. Philosophy: a proactive approach built around AI and automation.',
   0.88, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-xlnet-ai', NULL, NULL, 'public', 'org_fact', 'xl_net_ai_capabilities',
   'XL.net AI capabilities (ai.xl.net): AI Service Desk (intelligent ticket triage, automated resolution, most issues resolved on first contact); AI-Driven Security (continuous threat monitoring, automated incident response); Predictive Analytics (anticipate failures, reduce downtime); Conversational AI (Tron Netter); Automated monthly AI-powered technology audits.',
   0.9, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),

  ('seed-xlnet-contact', NULL, NULL, 'public', 'org_fact', 'xl_net_contact',
   'Contact XL.net: email Tron Netter at Tron.Netter@ai.xl.net. Tron Netter''s own AI line, call or text 24/7: (872) 350-4325 — the only number for reaching Tron Netter himself. Sales / general inquiries (human team): +1 (844) 915-5155. Websites: https://xl.net and https://ai.xl.net.',
   0.92, 1, 'seed', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))

ON CONFLICT (id) DO UPDATE SET
  scope = EXCLUDED.scope,
  kind = EXCLUDED.kind,
  key = EXCLUDED.key,
  value = EXCLUDED.value,
  importance = EXCLUDED.importance,
  salience = EXCLUDED.salience,
  source_type = EXCLUDED.source_type,
  updated_at = EXCLUDED.updated_at;

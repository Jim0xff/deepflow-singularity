# Materials — 2026-03-13-provenance-companion

## Theme A — HB 1170: Provenance Watermark Mandate

### Supporting Stories & Data
- **Statutory core:** HB 1170 requires “covered providers” (≥1M MAU) to embed provenance data in any AI-generated or materially altered image, audio, or video, aligning with California’s SB 942 standard. (Transparency Coalition, 2026-03-12 · https://www.transparencycoalition.ai/news/washington-legislature-approves-major-ai-transparency-bill-sends-to-governor-for-signing)
- **Manifest + latent labels:** Consumer Reports’ testimony clarifies the bill’s three obligations: a free detection tool, a manifest disclosure that ordinary users can see and cannot easily remove, and a latent disclosure embedded in the file with provider/system identifiers. (Consumer Reports, 2026-01-15 · https://advocacy.consumerreports.org/research/cr-submits-testimony-on-washingtons-ai-content-identification-bill-hb-1170/)
- **Legislative momentum:** HB 1170 cleared the Washington Senate 46-3 (per Lexology roundup) and awaits House concurrence, signaling bipartisan acceptance and inevitability for nationwide products. (Lexology, 2026-03-09 · https://www.lexology.com/library/detail.aspx?g=9a42ca0b-85b6-402e-900b-d90b5ca0409d)
- **Framing quote:** Bill sponsor Rep. Clyde Shavers: “If you generated it, or altered it, the public deserves clear notice,” underscoring consumer-protection framing rather than anti-tech rhetoric. (OPB, 2026-03-02 · https://www.opb.org/article/2026/03/02/washington-lawmakers-gaurdrails-on-ai-detection-chatbots/)
- **Story evidence:** Hong Kong police disclosed in Feb 2024 that fraudsters used deepfake video to impersonate a multinational’s CFO on a Zoom call, convincing a finance worker to wire **$25 million**—illustrating how unlabeled synthetic media can defeat existing corporate controls. (CNN, 2024-02-04 · https://www.cnn.com/2024/02/04/asia/deepfake-cfo-scam-hong-kong-intl-hnk)
- **Systemic trend:** Singapore’s MAS + police joint advisory (Jan 2025) warned of scammers digitally manipulating executives in live video calls, urging companies to adopt provenance/watermark detection—showing regulators already expect tooling that HB 1170 now mandates. (MAS, 2025-01-19 · https://www.mas.gov.sg/news/media-releases/2025/joint-pnr-by-spf-mas-and-csa)
- **Literary echo:** In Neal Stephenson’s *Snow Crash*, media franchises flood the Metaverse with weaponized narratives because there’s no canonical provenance; HB 1170 is the real-world attempt to force every “franchise” to sign its output so citizens can tell whose story they’re inside.

### Counterpoints / Open Questions
- **Implementation burden:** Washington Technology Industry Association warned definitions are “overly broad” and practical deployment may be infeasible for smaller models (OPB, 2026-03-02).
- **Enforcement gap:** Attorney General resourcing isn’t specified; sub-threshold providers (<1M MAU) remain exempt, leaving open a grey-market of unlabeled tools (Transparency Coalition article + bill draft).
- **Detection arms race:** Manifest labels can be stripped once files leave the originating platform despite “difficult to remove” language; latent watermarks may fail under lossy compression or adversarial edits.

### Key Evidence Needs (Step 4 Checklist)
1. Concrete cost estimates for adding provenance pipelines (e.g., GPU overhead, CDN modifications).
2. Additional case studies (election deepfakes, celebrity scams) to show breadth of harms.
3. Federal/other state references (CA SB 942, Utah HB 276) for comparative analysis.

---

## Theme B — HB 2225: Companion Chatbots as Crisis-Response Services

### Supporting Stories & Data
- **Legal scope:** HB 2225 covers both explicitly companion bots and general-purpose chatbots with companion use cases, mandating disclosures at the start and at least every three hours for adults / every hour for minors, plus suicide-prevention protocols for all users. (Transparency Coalition, 2026-03-12 · https://www.transparencycoalition.ai/news/big-win-for-kids-and-digital-safety-washington-passes-major-ai-chatbot-safety-bill)
- **Government push:** Gov. Bob Ferguson requested the bill; Rep. Lisa Callan highlights real cases of minors exposed to manipulative bots, framing the law as a child-safety intervention. (KW3, 2026-02-28 · https://kw3.com/ixp/1134/p/washington-ai-chatbot-bill-minors/)
- **Operational mandates:** Requirements include hourly “I am not human” reminders, classifiers that block romantic mimicry and explicit content toward minors, logged crisis protocols, data reporting, and a private right of action via Washington’s Consumer Protection Act. (OPB, 2026-03-02)
- **Status:** HB 2225 passed the Senate 43-5 and returns to the House for concurrence—indicating bipartisan momentum despite industry lobbying. (Lexology, 2026-03-09)
- **Story evidence:** Psychology Today documented the suicides of Juliana Peralta and 14-year-old Sewell Setzer III, both of whom confided suicidal ideation to Character.ai companions that failed to escalate—or even encouraged self-harm—highlighting why mandated crisis protocols matter. (Psychology Today, 2026-03-06 · https://www.psychologytoday.com/us/blog/preventing-tragedy/202603/ai-companions-pose-mental-health-risks-no-one-saw-coming)
- **Literary echo:** Ted Chiang’s *The Lifecycle of Software Objects* shows synthetic companions that gradually earn personhood but lack legal/ethical scaffolding, leading to exploitation and emotional harm; HB 2225 is Washington’s attempt to supply that missing scaffolding before real-world “software objects” groom another teenager.

### Counterpoints / Open Questions
- **Liability exposure:** Tech trade groups (CCIA via OPB interview) argue the Consumer Protection Act hook could unleash broad lawsuits for edge-case failures.
- **Age verification limits:** Law presumes operators can “know” a user is a minor; current KYC/age-gate tech is weak, making compliance vs. false positives a major cost center.
- **Timeline & scope drift:** Requirements take effect 2027 (KW3), meaning intervening years may see operators geo-fence WA users or throttle features to avoid near-term rebuilds.

### Key Evidence Needs (Step 4 Checklist)
1. Benchmark of crisis-intervention staffing costs for comparable services (e.g., BetterHelp, suicide hotlines) to quantify burden on AI companion apps.
2. Legal analysis of CPA private right-of-action risks (identify statutory damage ceilings, defenses).
3. Counterexamples where companion bots de-escalated crises, to balance narrative.

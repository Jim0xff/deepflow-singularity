# Hotspot Collection Script

Version: 2026-03-12
Owner: Sentinel
Schedule: Daily 09:00 & 21:00 Asia/Shanghai (manual trigger until cronized)

---
## 0. Purpose
Collect multi-layer AI hotspot signals, score them with the 5-dimensional rubric, and deliver a briefing to the Jim24 group plus an archival copy in `.openclaw/material-records/`.

---
## 1. Data Sources

### 1.1 Signal 1 — Fact Wire
| Source | Access | Notes |
| --- | --- | --- |
| Reuters Technology / AI | RSS / Web summary | Focus on global AI incidents, corporate moves |
| Bloomberg Technology (AI tag) | RSS / Web summary | Financial + infra coverage |
| Financial Times AI hub | RSS / Web summary | Policy + macro |
| MIT Technology Review AI | RSS | Research-grade news |
| Google Alerts | Email/RSS | Use keyword buckets listed in §2.1 |

### 1.2 Signal 2 — Technical & Community
| Source | Access | Notes |
| --- | --- | --- |
| Hacker News | `https://news.ycombinator.com/newest` (manual/CLI) | Filter posts/comments by keywords |
| Reddit r/MachineLearning | API/RSS | Use `new` + `rising` |
| Reddit r/ArtificialIntelligence | API/RSS | Ditto |
| Reddit r/AI_ethics | API/RSS | Ditto |
| Reddit r/singularity | API/RSS | Ditto |
| LessWrong & Alignment Forum | Web/RSS | Capture longform reactions |

### 1.3 Signal 3 — Thought & Commentary
| Source | Access | Notes |
| --- | --- | --- |
| Substack authors: Ethan Mollick, Douglas Rushkoff, Sinead Bovell, etc. | RSS | Use for narrative interpretation |
| AI Now Institute | Newsletter / site | Policy + societal impact |
| UNESCO AI Ethics | Reports | Governance perspective |
| CivAI / Civic AI Security | Blog | Democratic risk |
| KOL watchlist (Lex Fridman, Harari, Shannon Vallor, Eric Sadin, Yoshua Bengio, Iason Gabriel) | Twitter/X lists / newsletters | Capture quotes |

### 1.4 Finance & Capital
| Source | Access | Notes |
| --- | --- | --- |
| Bloomberg / FT deal coverage | RSS | Funding, M&A |
| The Information | Manual summary | Venture + infra |
| Crunchbase / PitchBook | API/manual | Funding rounds |
| Big Tech earnings calls (MSFT, GOOGL, AMZN, NVDA) | Transcript | Capex, AI spend |

### 1.5 Policy & Reports
| Source | Access | Notes |
| --- | --- | --- |
| Stanford AI Index | Annual/quarterly | Data backbone |
| International AI Safety Report | PDF | Risk & regulation |
| AI Safety Institutes (US/UK/EU) | Releases | Eval protocols |
| National AI Acts / Exec Orders | Official releases | Governance triggers |

---
## 2. Filters & Triggers

### 2.1 Keyword Buckets
Use these across Google Alerts, RSS filters, and manual triage:
- **Technical Breakthroughs:** "frontier model", "state of the art", "agentic", "Mixture of Experts", "tool use", "self-improvement", "test-time compute".
- **Social Phenomena:** "AI layoffs", "AI companion", "AI addiction", "deepfake election", "AI propaganda", "AI copyright lawsuit".
- **Finance & Capital:** "AI funding round", "AI startup acquisition", "GPU shortage", "datacenter capex", "sovereign AI".
- **Policy & Governance:** "AI regulation", "frontier model policy", "compute governance", "AI licensing", "AI export controls".
- **Security / Incidents:** "prompt injection", "model leak", "weights leaked", "AI agent incident", "alignment failure".
- **Energy / Infra:** "AI datacenter power demand", "AI carbon", "grid capacity", "nuclear power AI".
- **Event Trigger Words:** "whistleblower" AND AI, "internal memo" AND AI, "banned AI", "lawsuit", "unexpected behavior".
- **Eight Philosophy Lanes:** Use terms tied to the AI 科幻哲学地图 to map incidents to the 8 archetypes (Watts, Egan, Banks, Religious, Simulation, Antimemetics, Ted Chiang, Vinge).

### 2.2 Inclusion Rule
- Must match ≥1 keyword bucket **and** present novel info.
- Deduplicate across sources.
- Auto-discard Level-1 noise unless explicitly requested.

---
## 3. Scoring & Tagging

For every retained event, fill the following fields:
1. **Primary Tag:** One of the 8 philosophy archetypes.
2. **Secondary Tags:** Up to two additional archetypes.
3. **Event Level:** L1 Noise / L2 Phenomenon / L3 Mechanism Shift / L4 Structural Break.
4. **5-D Score (0-2 each):**
   - Compute (infrastructure impact)
   - Governance (legal/policy)
   - Narrative (information ecosystem)
   - Behavior (human/organizational change)
   - Capability (ability leap)
   - **Filter:** Total ≥7 → include; ≥9 → High Alert section.
5. **Key Variables:** Three bullet metrics to monitor.
6. **Propagation Chain:** C→M→S→P→H (Compute → Market → Society → Policy → Human meaning).
7. **Counterpoint:** One sentence.
8. **Judgment:** One-sentence interpretation.

---
## 4. Output Format

### 4.1 Briefing Markdown (group delivery)
```
# AI Hotspot Briefing — YYYY-MM-DD HH:MM

## High Alerts (Score ≥9)
1. **[Title]** — Source (Time)
   - Tags: Primary / Secondary
   - Level / Score: L3 · 9/10 (C1 G2 N2 B2 Cap2)
   - Key Vars: …
   - C→M→S→P→H: …
   - Counterpoint: …
   - Judgment: …

## Watchlist (Score 7-8)
...

## Raw Materials
- [Link](URL)
- ...
```

### 4.2 Archive File
- Path: `.openclaw/material-records/YYYY-MM-DD.md`
- Mirror briefing + append "Raw Materials" table (Title / Source / Link / Tag / Score / Notes).

---
## 5. Execution Steps (Manual for now)
1. Refresh feeds (RSS/Alerts/API exports) and dump into `/tmp/hotspot_raw/YYYYMMDD/`.
2. Run keyword filter (e.g., `rg -i -f keyword_list.txt ...`).
3. For each candidate, fill `event_cards/YYYMMDD-HHMM.md` with template in §3.
4. Synthesize briefing sections.
5. Deliver to Jim24 group (paste) and save archive file.
6. Store raw materials + references in `.openclaw/material-records/attachments/YYYYMMDD/` if needed.

---
## 6. Future Automation Hooks
- Convert Steps 1-3 into CLI workflows (HN/Reddit API scripts, Substack fetcher).
- Cron integration once scripts are executable.
- Use NotebookLM or local embeddings for dedupe and linking back to AI 科幻哲学地图 when drafting theses.

---
_End of script._

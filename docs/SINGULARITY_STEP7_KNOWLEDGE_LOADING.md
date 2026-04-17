# Singularity Step 7 Knowledge Loading

This document records the agreed minimal Step 7 knowledge-loading design.

Principles:

- `draft-writer` reads thick shared writing context.
- `reviewer` reads shared gates and review rules.
- `final-writer` does not read thick shared knowledge directly.
- `main` does not build an extra `final_packet` file.
- `main` is the only manual entrypoint for writing reusable knowledge back into shared libraries.
- `supervisor` assembles the minimal `final-writer` prompt from existing project files.
- Runtime Step 7 agents write only project files, not shared knowledge libraries.

Manual capture triggers handled by `main`:

- `保存模板`
- `保存门禁`
- `保存写作规则 / 保存写作法则 / 保存写作铁律`
- `保存修稿模式`
- `存到知识库 / 写进知识库` as generic capture intent; if type is unclear, `main` asks which kind

## Minimal Architecture

```mermaid
flowchart LR
  subgraph KB["Shared Knowledge (human maintained)"]
    T["templates/<br/>structure templates"]
    W["knowledge/writing_rules/<br/>writing rules and anchors"]
    G["knowledge/review_gates/<br/>review gates"]
    RP["knowledge/repair_patterns/<br/>repair patterns"]
  end

  subgraph P["Project Files (runtime)"]
    H["handoff.md<br/>draft brief"]
    O["output.md<br/>draft article"]
    F["final-output.md<br/>formal article"]
    D["draft_review_history.md<br/>raw review and revision log"]
    S["status.md"]
  end

  subgraph RT["Runtime Assembly"]
    SP["supervisor prompt builder<br/>reads current project files"]
  end

  M["main"]
  DW["draft-writer"]
  R["reviewer"]
  FW["final-writer"]

  T --> DW
  W --> DW

  G --> R
  RP --> R
  T --> R

  H --> DW
  O --> DW
  D --> DW

  O --> R
  F --> R
  D --> R

  O --> SP
  F --> SP
  D --> SP
  S --> SP
  SP --> FW

  M --> S
  M --> D

  DW --> O
  DW --> D
  DW --> S

  R --> D
  R --> S

  FW --> F
  FW --> D
  FW --> S
```

## Full Loading Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant M as main
  participant S as supervisor
  participant DW as draft-writer
  participant R as reviewer
  participant FW as final-writer
  participant P as project files

  Note over M,DW: Step 7 draft stage
  U->>M: Enter Step 7
  M->>M: Switch state only
  M->>S: hand off to supervisor

  S->>DW: dispatch draft-writer
  DW->>P: read status.md
  DW->>P: read handoff.md
  DW->>P: read output.md
  DW->>P: read draft_review_history.md
  DW->>DW: read templates and knowledge/writing_rules/
  DW->>P: write output.md
  DW->>P: append draft_review_history.md
  DW->>P: write status.md(next_actor=reviewer)

  S->>R: dispatch reviewer for draft
  R->>P: read output.md
  R->>P: read draft_review_history.md
  R->>R: read knowledge/review_gates/ and knowledge/repair_patterns/
  R->>R: read bound template
  R->>P: append draft_review_history.md(verdict and issues)
  R->>P: write status.md(next_actor=writer or main)

  Note over M,FW: Formal article generation
  U->>M: Generate formal article
  M->>M: switch state only
  M->>S: hand off to supervisor

  S->>P: read status.md, output.md, draft_review_history.md
  S->>FW: dispatch final-writer generate
  Note right of FW: prompt contains only<br/>1. output.md as base<br/>2. latest final-stage instructions<br/>3. a few hard constraints
  FW->>P: write final-output.md
  FW->>P: append draft_review_history.md
  FW->>P: write status.md(next_actor=reviewer or main)

  Note over R: Formal review
  S->>R: dispatch reviewer for final
  R->>P: read final-output.md
  R->>P: read draft_review_history.md
  R->>R: read knowledge/review_gates/ and knowledge/repair_patterns/
  R->>P: append draft_review_history.md
  R->>P: write status.md(next_actor=final_writer or main)

  Note over M,FW: Final revision
  U->>M: Continue modifying or send free-text feedback
  M->>P: append raw final-stage user feedback to draft_review_history.md
  M->>S: switch state for final-writer
  S->>P: read final-output.md and latest final feedback blocks
  S->>FW: dispatch final-writer revise
  Note right of FW: revise mode reads only<br/>1. final-output.md<br/>2. latest final reviewer block<br/>3. latest final user block
  FW->>P: write final-output.md
  FW->>P: append draft_review_history.md
  FW->>P: write status.md
```

## Knowledge Loading Comparison

```mermaid
flowchart TD
  T["templates/"] --> DW["draft-writer"]
  W["knowledge/writing_rules/"] --> DW

  G["knowledge/review_gates/"] --> R["reviewer"]
  RP["knowledge/repair_patterns/"] --> R
  T --> R

  O["output.md or final-output.md"] --> FW["final-writer"]
  D["latest final reviewer block or latest final user block"] --> FW
  S["status.md"] --> FW

  X1["does not read templates directly"] -.-> FW
  X2["does not read knowledge/writing_rules/ directly"] -.-> FW
  X3["does not read review_gates/ or repair_patterns/ directly"] -.-> FW
```

## Knowledge Maintenance

```mermaid
flowchart TD
  H["Human or Editor"] --> M["main"]
  M --> T["templates/"]
  M --> W["knowledge/writing_rules/"]
  M --> G["knowledge/review_gates/"]
  M --> RP["knowledge/repair_patterns/"]

  RUNTIME["Step 7 runtime"] --> O["output.md"]
  RUNTIME --> F["final-output.md"]
  RUNTIME --> D["draft_review_history.md"]
  RUNTIME --> S["status.md"]

  NOTE["Only manual capture via main:<br/>- no auto-ingest into shared KB<br/>- no extra final_packet file<br/>- candidate extraction not in scope"]
```

## Read and Write Boundaries

- `draft-writer`
  - Reads: `handoff.md`, `output.md`, `draft_review_history.md`, `templates`, `knowledge/writing_rules/`
  - Writes: `output.md`, `draft_review_history.md`, `status.md`
- `reviewer`
  - Reads: current article file, `draft_review_history.md`, bound template, `knowledge/review_gates/`, `knowledge/repair_patterns/`
  - Writes: `draft_review_history.md`, `status.md`
- `final-writer`
  - Reads on first formal pass: `output.md`, `status.md`, latest final-stage instructions assembled by supervisor
  - Reads on final revision: `final-output.md`, `status.md`, latest final reviewer block, latest final user block
  - Writes: `final-output.md`, `draft_review_history.md`, `status.md`
- `main`
  - Writes only state and user raw feedback
  - Is the only manual entry for saving reusable Step 7 knowledge into shared libraries
  - Does not build a dedicated `final_packet` file
  - Does not write article body

## Minimal Final-Writer Inputs

The final-writer only needs:

1. the current base article file
2. the latest raw final-stage feedback
3. a small set of hard constraints embedded in the supervisor dispatch

The final-writer does not need:

- full writing knowledge libraries
- full gate libraries
- full debate history
- a dedicated extra handoff file for final generation

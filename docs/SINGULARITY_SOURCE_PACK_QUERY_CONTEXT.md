# Singularity Source-Pack Query Context

This document records the agreed minimal source-pack query design.

## Goal

- Keep source-pack binding as availability only.
- Stop treating `PACK.md -> GUIDE.md -> files` as an automatic runtime read path.
- Make source-pack use explicit:
  - user/editor says what to look up
  - `main` performs the lookup
  - `main` stores both summary and matched full text in one project file
  - `writer / reviewer / final-writer` consume that file by default
- Avoid append-only drift and duplicated evidence paths.

## Decision

- Keep current source-pack structure unchanged.
- Add one new project file:
  - `source_pack_queries.json`
- `main` is the only role allowed to read raw source-pack files during normal project flow.
- `writer / reviewer / final-writer` must not read `PACK.md`, `GUIDE.md`, or raw source-pack files directly by default.
- Keep one narrow escape hatch:
  - if editor/user explicitly requires raw source-pack reading, downstream roles may read raw pack files for that task only
- Source-pack consumption becomes:
  - explicit query
  - deterministic refresh
  - downstream JSON-first consumption

## New Project File

Path:

- `/.openclaw/shared/projects/<project_id>/source_pack_queries.json`

Shape:

- JSON array
- newest-first
- `UPSERT_BY(query_key)`
- no blind append

Example:

```json
[
  {
    "query_key": "白象设定",
    "pack_ids": [
      "black-myth-wukong-story-analysis-v1"
    ],
    "query": "白象设定",
    "matched_files": [
      "/.openclaw/shared/source-packs/black-myth-wukong-story-analysis-v1/enemy_profiles/enemy_160_黄风大圣.md",
      "/.openclaw/shared/source-packs/black-myth-wukong-story-analysis-v1/enemy_profiles/enemy_201_铁扇公主.md"
    ],
    "summary": [
      "妖王并非天然统治者，而是被更上游秩序驱赶的执行者。",
      "器物、旧伤、羞辱史可绑定人物权力感。"
    ],
    "fulltext": [
      {
        "file": "/.openclaw/shared/source-packs/black-myth-wukong-story-analysis-v1/enemy_profiles/enemy_160_黄风大圣.md",
        "text": "..."
      },
      {
        "file": "/.openclaw/shared/source-packs/black-myth-wukong-story-analysis-v1/enemy_profiles/enemy_201_铁扇公主.md",
        "text": "..."
      }
    ],
    "updated_at": "2026-05-06T11:40:00Z"
  }
]
```

Rules:

- `query_key = normalized_query`
- `pack_ids` must record which bound packs actually supplied matched files
- same `query_key` must replace existing entry
- do not mirror the same data into `draft_review_history.md`
- keep only query results in this file

## Main Flow

`main` gets one explicit query transaction:

```text
[SPQ]
SPQ=source_pack_queries.json
SPQ_MODE=EXPLICIT_ONLY+MAIN_ONLY+BOUND_SCOPE+NO_AUTO_PACK_READ
SPQ_TX=TEXT(查素材包 ...)->PARSE(query)->DERIVE_BOUND_PACKS->READ(BOUND_PACKS/PACK.md)->READ(BOUND_PACKS/GUIDE.md)->MATCH(query)->LIMIT_MATCH(<=5)+BLOCK_IF_FULLTEXT_OVER_80KB->READ(MATCHED_FILES_ONLY)->REFRESH_SPQ_JSON(UPSERT_BY(query_key),pack_ids,query,matched_files,summary,fulltext,updated_at)->REREAD_VERIFY
SPQ_FAIL=NO_BOUND_PACK_OR_NO_MATCH_OR_MATCH_TOO_BROAD_OR_FULLTEXT_TOO_LARGE->PLAIN_REPLY_AND_KEEP_SPQ_UNCHANGED
```

Meaning:

- `main` must query source-pack content only when explicitly asked
- query result is written once into `source_pack_queries.json`
- write mode is refresh/upsert, not append
- if the query is too broad, `main` must stop instead of dumping a giant context file

## Downstream Consumption

`writer / reviewer / final-writer` consume `source_pack_queries.json` by default.

Shared rule:

```text
SPQ_RULE=IF_EDITOR_OR_USER_REQUESTS_SOURCE_PACK->READ_LATEST_MATCHING_SPQ_JSON_ONLY+NO_RAW_PACK_READ_BY_DEFAULT
SPQ_GATE=IF_NO_MATCHING_SPQ_JSON->BLOCK_AND_ASK_MAIN_TO_QUERY_PACK_FIRST
SP_RAW_RULE=ONLY_IF_EDITOR_OR_USER_EXPLICIT_RAW_PACK_READ->READ(PACK.md)->READ(GUIDE.md)->MATCH_TASK->READ(MATCHED_FILES_ONLY)
```

Meaning:

- if the current task explicitly depends on source-pack material, the role must read the latest matching query result from `source_pack_queries.json`
- if no matching query result exists, the role must not pretend it already read the pack
- it must stop and require `main` to query first
- if editor/user explicitly requires raw source-pack reading, the role may bypass JSON-first mode for that task only and read matched raw files directly

## AGENTS Changes

### `assets/singularity-main/AGENTS.md`

Add:

```text
SPQ=source_pack_queries.json
SPQ_MODE=EXPLICIT_ONLY+MAIN_ONLY+BOUND_SCOPE+NO_AUTO_PACK_READ
SPQ_TX=TEXT(查素材包 ...)->PARSE(query)->DERIVE_BOUND_PACKS->READ(BOUND_PACKS/PACK.md)->READ(BOUND_PACKS/GUIDE.md)->MATCH(query)->LIMIT_MATCH(<=5)+BLOCK_IF_FULLTEXT_OVER_80KB->READ(MATCHED_FILES_ONLY)->REFRESH_SPQ_JSON(UPSERT_BY(query_key),pack_ids,query,matched_files,summary,fulltext,updated_at)->REREAD_VERIFY
SPQ_FAIL=NO_BOUND_PACK_OR_NO_MATCH_OR_MATCH_TOO_BROAD_OR_FULLTEXT_TOO_LARGE->PLAIN_REPLY_AND_KEEP_SPQ_UNCHANGED
```

Keep:

- source-pack save / bind / unbind

Remove semantic dependence on:

- `SP_READ_TX=IF_BOUND->...`

### `assets/singularity-writer/AGENTS.md`

Replace:

- `SP_READ_TX=IF_BOUND->READ(PACK.md)->READ(GUIDE.md)->MATCH_TASK->READ(MATCHED_FILES_ONLY)->APPEND_DRH(...)`
- `SP_RULE=INDEX_FIRST+MATCH_ONLY+NO_FULL_PACK_READ+PROJECT_MD_IS_BIND_SOURCE`

With:

```text
SPQ_RULE=IF_EDITOR_OR_USER_REQUESTS_SOURCE_PACK->READ_LATEST_MATCHING_SPQ_JSON_ONLY+NO_RAW_PACK_READ_BY_DEFAULT
SPQ_GATE=IF_NO_MATCHING_SPQ_JSON->BLOCK_AND_ASK_MAIN_TO_QUERY_PACK_FIRST
SP_RAW_RULE=ONLY_IF_EDITOR_OR_USER_EXPLICIT_RAW_PACK_READ->READ(PACK.md)->READ(GUIDE.md)->MATCH_TASK->READ(MATCHED_FILES_ONLY)
```

### `assets/singularity-reviewer/AGENTS.md`

Replace the same source-pack read rule with:

```text
SPQ_RULE=IF_EDITOR_OR_USER_REQUESTS_SOURCE_PACK->READ_LATEST_MATCHING_SPQ_JSON_ONLY+NO_RAW_PACK_READ_BY_DEFAULT
SPQ_GATE=IF_NO_MATCHING_SPQ_JSON->BLOCK_AND_ASK_MAIN_TO_QUERY_PACK_FIRST
SP_RAW_RULE=ONLY_IF_EDITOR_OR_USER_EXPLICIT_RAW_PACK_READ->READ(PACK.md)->READ(GUIDE.md)->MATCH_TASK->READ(MATCHED_FILES_ONLY)
```

### `assets/singularity-final-writer/AGENTS.md`

Replace the same source-pack read rule with:

```text
SPQ_RULE=IF_EDITOR_OR_USER_REQUESTS_SOURCE_PACK->READ_LATEST_MATCHING_SPQ_JSON_ONLY+NO_RAW_PACK_READ_BY_DEFAULT
SPQ_GATE=IF_NO_MATCHING_SPQ_JSON->BLOCK_AND_ASK_MAIN_TO_QUERY_PACK_FIRST
SP_RAW_RULE=ONLY_IF_EDITOR_OR_USER_EXPLICIT_RAW_PACK_READ->READ(PACK.md)->READ(GUIDE.md)->MATCH_TASK->READ(MATCHED_FILES_ONLY)
```

## Adapter Changes

`scripts/supervisor/adapters/singularity-flow.mjs`

Required updates:

- add `source_pack_queries.json` to project file set
- `writer / reviewer / final-writer` prompt must read:
  - `source_pack_queries.json` if present
- do not inject:
  - `Bound source packs for ...`
  - `PACK.md`
  - `GUIDE.md`
  - `source_pack_read`
- if latest editor/reviewer block explicitly references source-pack use, the prompt must say:
  - use `source_pack_queries.json` first
  - do not read raw source-pack files directly unless editor/user explicitly requests raw reading

## Non-Goals

- no automatic whole-pack read after binding
- no append-only source-pack audit trail in `draft_review_history.md`
- no duplicated storage across `draft_review_history.md`, `materials.md`, and `project.md`
- no runtime fallback where `writer/reviewer/final-writer` “guess” pack content from binding alone

## One-Line Summary

Use source-packs as an indexed library, not an automatic full-read bundle: `main` performs explicit pack queries and refreshes `source_pack_queries.json`; downstream roles consume that JSON first and may read matched raw files only under explicit editor/user authorization.

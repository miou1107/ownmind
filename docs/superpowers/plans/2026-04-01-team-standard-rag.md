# Team Standard RAG (Sub-node Enhancement) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a RAG system for Team Standards by chunking Markdown files using a header-based strategy, allowing AI agents to retrieve detailed subsections when relevant.

**Architecture:** Integrate a header-based Markdown parser into the MCP server. Use a summary-first retrieval strategy: load `team_standard` summaries initially, and then use semantic/keyword search to fetch linked `standard_detail` chunks (child nodes) as needed. Use incremental updates (hashing) to avoid redundant storage.

**Tech Stack:** Node.js, Express, SQLite/PostgreSQL, Markdown-it (or similar parser), MCP SDK.

---

## Chunk 1: Infrastructure & Schema

**Goal:** Update the database and constants to support the new `standard_detail` memory type.

**Files:**
- Create: `c:\Users\Eric\ownmind\db\005_add_standard_detail.sql`
- Modify: `c:\Users\Eric\ownmind\src\constants.js`

- [ ] **Step 1: Create DB Migration**
  Create `db/005_add_standard_detail.sql` to add the new type to the `memories_type_check` constraint.
  ```sql
  -- Update the CHECK constraint to include standard_detail
  ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
  ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
      'profile', 'principle', 'iron_rule', 'coding_standard',
      'team_standard', 'project', 'portfolio', 'env', 'session_log', 'standard_detail'
  ));
  ```

- [ ] **Step 2: Update Constants**
  Modify `src/constants.js:7-17` to include `standard_detail`.
  ```javascript
  export const ALLOWED_MEMORY_TYPES = [
    // ...existing,
    'standard_detail',
  ];
  ```

- [ ] **Step 3: Commit Infrastructure**
  ```bash
  git add db/005_add_standard_detail.sql src/constants.js
  git commit -m "chore: add standard_detail memory type to schema and constants"
  ```

---

## Chunk 2: Markdown Parser Utility

**Goal:** Build a robust Markdown parser that splits content by headers (H1-H3) and inherits parent context.

**Files:**
- Create: `c:\Users\Eric\ownmind\src\utils\md-parser.js`
- Create: `c:\Users\Eric\ownmind\tests\utils\md-parser.test.js`

- [ ] **Step 1: Implement `parseStandardMarkdown`**
  ```javascript
  // src/utils/md-parser.js
  export function parseStandardMarkdown(content, maxDepth = 3) {
    const lines = content.split('\n');
    const chunks = [];
    let currentPath = [];
    let currentContent = [];
    
    // Logic: Iterate lines, detect # headers.
    // If header level <= maxDepth, flush current chunk and start new.
    // Chunk title = Path > Header Title
    // Chunk content = Raw content lines
    // Chunk hash = sha256(content)
    return chunks; // Array of { title, content, level, hash }
  }
  ```

- [ ] **Step 2: Write tests for parser**
  Verify inheritance: `## Parent` -> `### Child` should result in chunk titled "Parent > Child".

- [ ] **Step 3: Run tests and verify**
  Run: `npm test tests/utils/md-parser.test.js`

- [ ] **Step 4: Commit Parser**
  ```bash
  git add src/utils/md-parser.js tests/utils/md-parser.test.js
  git commit -m "feat: implement header-based markdown parser with inheritance"
  ```

---

## Chunk 3: Backend API for Batch Upload

**Goal:** Create an endpoint to handle batch saving of standards and their details with incremental update logic.

**Files:**
- Modify: `c:\Users\Eric\ownmind\src\routes\memory.js`

- [ ] **Step 1: Add `POST /api/memory/batch-sync-standard`**
  Logic:
  1. Receive `parent_title`, `chunks[]`.
  2. Find or create the `team_standard` with `parent_title`.
  3. Fetch existing `standard_detail` records for this parent.
  4. Compare hashes in `chunks[]` with existing ones in DB.
  5. Delete vanished chunks, update changed ones, insert new ones.
  6. Return sync summary (Added/Updated/Deleted counts).

- [ ] **Step 2: Commit Backend Changes**
  ```bash
  git add src/routes/memory.js
  git commit -m "feat: add backend batch-sync endpoint for standards"
  ```

---

## Chunk 4: MCP Tool Integration

**Goal:** Expose the upload functionality to AI agents via new MCP tools.

**Files:**
- Modify: `c:\Users\Eric\ownmind\mcp\index.js`

- [ ] **Step 1: Register `ownmind_upload_standard`**
  Description: Reads a local `.md` file, returns a preview list of chunks for review.
  Input: `file_path`, `title`.
  Returns: `session_id`, `preview: [{ title, action: 'add'|'update'|'delete' }]`.

- [ ] **Step 2: Register `ownmind_confirm_upload`**
  Description: Finalizes the sync for the given `session_id`.
  Input: `session_id`.

- [ ] **Step 3: Add "Auto-Iron-Rule" detection prompt in MCP**
  When returning the preview, instruct the Agent to check if any chunk should be flagged as an `iron_rule`.

- [ ] **Step 4: Commit MCP Changes**
  ```bash
  git add mcp/index.js
  git commit -m "feat: add ownmind_upload_standard and confirm tools to MCP"
  ```

---

## Chunk 5: AI Guidance & SOP

**Goal:** Update the instructions so AI knows how to leverage the new RAG capability.

**Files:**
- Modify: `c:\Users\Eric\ownmind\src\routes\memory.js`

- [ ] **Step 1: Update `INSTRUCTIONS_SOP`**
  Add a section:
  "## 團隊規範 RAG
  當觸發團隊規範時，優先讀取摘要。若摘要提及「參閱細項」，請使用 `ownmind_search` 或針對特定摘要 ID 查詢預設的 `standard_detail` 類型記憶來獲取細節。"

- [ ] **Step 2: Final Commit**
  ```bash
  git add src/routes/memory.js
  git commit -m "docs: update AI SOP for Team Standard RAG"
  ```

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-01-team-standard-rag.md`. Ready to execute?**

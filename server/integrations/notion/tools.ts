// Notion's hosted MCP tools and how the broker classifies them (docs/MCP-BROKER.md, "What counts as risky").
// Source: https://developers.notion.com/guides/mcp/mcp-supported-tools (fetched 2026-10-16; 56 tools).
// Risky = irreversible only. Deleting pages or databases moves them to Trash, but the plan treats them as risky;
// deleting a comment has no Trash at all. The list has no share/publish tool today; a future one is unknown here and
// falls back to the generic heuristic, whose word list catches "share" and "publish".
// Everything else either reads (`read`) or creates/edits (`write`), which goes through without asking.

export type NotionToolClass = "read" | "write" | "risky";

export interface NotionToolSpec {
  cls: NotionToolClass;
  /** Candidate argument names holding the target ids; the first one the tool's input schema declares wins. */
  target?: string[];
}

export const NOTION_TOOLS: Readonly<Record<string, NotionToolSpec>> = {
  // Search and access
  "notion-search": { cls: "read" },
  "notion-ai-search": { cls: "read" },
  "notion-memory-search": { cls: "read" },
  "notion-get-tool-access": { cls: "read" },
  "notion-get-self": { cls: "read" },
  // Skills
  "notion-download-skill": { cls: "read" },
  "notion-upload-skill": { cls: "write" },
  "notion-get-enabled-skills": { cls: "read" },
  "notion-update-enabled-skills": { cls: "write" },
  "notion-convert-page-to-skill": { cls: "write" },
  // Reading content
  "notion-fetch": { cls: "read" },
  "notion-get-file-download-urls": { cls: "read" },
  "notion-list-private-pages": { cls: "read" },
  "notion-list-shared-pages": { cls: "read" },
  "notion-list-favorite-pages": { cls: "read" },
  "notion-list-recent-pages": { cls: "read" },
  "notion-list-page-backlinks": { cls: "read" },
  // Files and attachments
  "notion-create-file-upload": { cls: "write" },
  "notion-create-attachment": { cls: "write" },
  "notion-download-attachment": { cls: "read" },
  // Pages, databases and folders
  "notion-create-pages": { cls: "write" },
  "notion-update-page": { cls: "write" },
  "notion-move-pages": { cls: "write" },
  "notion-delete-pages": { cls: "risky", target: ["page_ids", "pages", "page_id", "ids", "id"] },
  "notion-delete-databases": {
    cls: "risky",
    target: ["database_ids", "databases", "database_id", "data_source_ids", "ids", "id"],
  },
  "notion-restore-pages": { cls: "write" },
  "notion-duplicate-page": { cls: "write" },
  "notion-create-database": { cls: "write" },
  "notion-create-folder": { cls: "write" },
  "notion-update-folder": { cls: "write" },
  "notion-update-data-source": { cls: "write" },
  "notion-create-view": { cls: "write" },
  "notion-update-view": { cls: "write" },
  // Queries (Notion documents the SQL here as read-only)
  "notion-query-data-sources": { cls: "read" },
  "notion-query-multiple-data-sources": { cls: "read" },
  "notion-query-meeting-notes": { cls: "read" },
  // Custom Agents
  "notion-search-agents": { cls: "read" },
  "notion-query-sessions": { cls: "read" },
  "notion-search-sessions": { cls: "read" },
  "notion-spawn-session": { cls: "write" },
  "notion-get-session-status": { cls: "read" },
  "notion-wait-session": { cls: "read" },
  "notion-stop-session": { cls: "write" },
  "notion-send-message-to-session": { cls: "write" },
  "notion-list-session-events": { cls: "read" },
  "notion-read-session-event": { cls: "read" },
  // Comments
  "notion-create-comment": { cls: "write" },
  "notion-get-comments": { cls: "read" },
  "notion-update-comment": { cls: "write" },
  "notion-delete-comment": { cls: "risky", target: ["comment_id", "id"] },
  "notion-set-discussion-resolved": { cls: "write" },
  "notion-set-comment-reaction": { cls: "write" },
  // Workspace and tasks
  "notion-get-teams": { cls: "read" },
  "notion-get-groups": { cls: "read" },
  "notion-get-users": { cls: "read" },
  "notion-get-async-task": { cls: "read" },
};

/** Short names Notion documents for the same tools (served to OpenAI clients). */
export const NOTION_ALIASES: Readonly<Record<string, string>> = {
  "ai-search": "notion-ai-search",
  fetch: "notion-fetch",
};

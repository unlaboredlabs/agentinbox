// T3 Code's MCP tools and how the broker classifies them (docs/MCP-BROKER.md, "What counts as risky").
// Source: tools/list of a live T3 Code server (t3@nightly 0.1.1-nightly.20261016.3218, 83 tools), 2026-10-16.
// T3 annotates nearly every write `destructiveHint: true` (sending to a thread, reordering a queue), so without this
// table the annotation rule would ask before almost everything. The table says what is irreversible instead.
// Risky = irreversible only, as everywhere: deleting, settings and environment writes, persistent automation, and
// sending data outside through the browser preview (page JavaScript, file uploads). Starting, messaging and stopping
// threads go straight through: T3's own access level (picked on its approval page) caps what a thread may run.
// A tool missing here (a newer T3) falls back to the generic rules: its annotations, then the verb list, which
// catches future `*_delete` / `*_remove` names (deleting a thread, removing a worktree).

export type T3ToolClass = "read" | "write" | "risky";

export interface T3ToolSpec {
  cls: T3ToolClass;
  /** Argument holding the target id, for "always allow … for this target" (a JSON Pointer is built from it). */
  target?: string;
}

export const T3_TOOLS: Readonly<Record<string, T3ToolSpec>> = {
  // Reading T3: projects, threads, queues, environment, worktrees, schedules, pull requests, devices. Free at every
  // level, listed at "read only".
  orchestrator_capabilities: { cls: "read" },
  t3_project_list: { cls: "read" },
  t3_project_read: { cls: "read" },
  t3_environment_read: { cls: "read" },
  t3_thread_list: { cls: "read" },
  t3_thread_read: { cls: "read" },
  t3_thread_search: { cls: "read" },
  t3_thread_wait: { cls: "read" },
  t3_thread_transfers: { cls: "read" },
  t3_thread_configuration: { cls: "read" },
  t3_pending_request_list: { cls: "read" },
  t3_pending_request_read: { cls: "read" },
  t3_queue_list: { cls: "read" },
  t3_queue_read: { cls: "read" },
  t3_worktree_status: { cls: "read" },
  t3_worktree_list: { cls: "read" },
  t3_preview_list: { cls: "read" },
  list_scheduled_tasks: { cls: "read" },
  task_status: { cls: "read" },
  list_thread_pull_requests: { cls: "read" },
  read_pull_request_guide: { cls: "read" },
  device_list: { cls: "read" },
  device_screenshot: { cls: "read" },
  preview_status: { cls: "read" },
  preview_snapshot: { cls: "read" },
  preview_wait_for: { cls: "read" },

  // Thread work: launch, send, interrupt and the rest of a thread's life (fork, queue, answer its questions,
  // delegate). Normal writes: they go through without asking at "ask". `send` and `merge` here are messages and
  // context between T3's own threads, not mail or git (see T3_NAME_CHECK_EXEMPT).
  t3_thread_launch: { cls: "write" },
  create_threads: { cls: "write" },
  t3_thread_send: { cls: "write" },
  t3_thread_send_attachments: { cls: "write" },
  t3_attachment_prepare_upload: { cls: "write" },
  t3_attachment_discard: { cls: "write" },
  t3_thread_interrupt: { cls: "write" },
  t3_thread_fork: { cls: "write" },
  t3_thread_merge_back: { cls: "write" },
  t3_thread_update: { cls: "write" },
  t3_thread_organize: { cls: "write" },
  t3_thread_configure: { cls: "write" },
  t3_pending_request_respond: { cls: "write" },
  t3_queue_edit: { cls: "write" },
  t3_queue_cancel: { cls: "write" },
  t3_queue_reorder: { cls: "write" },
  t3_queue_promote_to_steer: { cls: "write" },
  delegate_task: { cls: "write" },
  task_cancel: { cls: "write" },
  t3_workflow_stop: { cls: "write" },
  request_secret: { cls: "write" },
  run_scheduled_task_now: { cls: "write" },

  // Projects and worktrees: creating, cloning and moving a thread into a new worktree add things; nothing is lost.
  t3_project_create: { cls: "write" },
  t3_project_clone: { cls: "write" },
  t3_worktree_handoff: { cls: "write" },

  // Pull requests: linking, watching and review guides are T3's own bookkeeping.
  link_pull_request: { cls: "write" },
  unlink_pull_request: { cls: "write" },
  watch_pull_request: { cls: "write" },
  unwatch_pull_request: { cls: "write" },
  write_pull_request_guides: { cls: "write" },

  // Browser previews, devices and rendered pages. The preview tools drive a browser on T3's machine in the user's own
  // browser profile, saved logins included (by default), so they can act on websites as the user. Deliberate: T3
  // access is close to acting as the user on that machine anyway (a launched thread runs whatever T3's level allows),
  // so opening, navigating, clicking and typing stay normal writes. Running page JavaScript (preview_evaluate) and
  // uploading local files (preview_upload) ask: see the risky group below. Writes, not reads: html_preview loads
  // whatever URLs the page names, so it isn't offered at "read only".
  preview_open: { cls: "write" },
  preview_navigate: { cls: "write" },
  preview_resize: { cls: "write" },
  preview_set_appearance: { cls: "write" },
  preview_click: { cls: "write" },
  preview_type: { cls: "write" },
  preview_hover: { cls: "write" },
  preview_select: { cls: "write" },
  preview_drag: { cls: "write" },
  preview_press: { cls: "write" },
  preview_scroll: { cls: "write" },
  preview_dialog: { cls: "write" },
  preview_recording_start: { cls: "write" },
  preview_recording_stop: { cls: "write" },
  t3_preview_close: { cls: "write" },
  device_open: { cls: "write" },
  device_close: { cls: "write" },
  html_render: { cls: "write" },
  html_preview: { cls: "write" },

  // Deleting: a project, a scheduled task. Irreversible, so it asks at "ask".
  t3_project_delete: { cls: "risky", target: "projectId" },
  delete_scheduled_task: { cls: "risky", target: "scheduledTaskId" },

  // Settings and environment writes: environment-wide preferences, and a project's settings (its scripts run on every
  // new worktree, its workspace root moves it). Asks.
  t3_environment_preferences_update: { cls: "risky" },
  t3_project_update: { cls: "risky", target: "projectId" },

  // Persistent automation: a schedule keeps starting agent turns with nobody watching, and a webhook schedule
  // publishes a public URL. Asks.
  schedule_task: { cls: "risky" },
  update_scheduled_task: { cls: "risky", target: "scheduledTaskId" },

  // The browser preview, in the user's profile with its saved logins: running JavaScript in a page (it can act on any
  // signed-in site and returns up to 64 KB of what it reads) and handing files from T3's machine to a web page.
  // Sending data outside, as the user. Asks.
  preview_evaluate: { cls: "risky" },
  preview_upload: { cls: "risky" },
};

/**
 * Tools whose name has a risky verb but whose action stays inside T3: `t3_thread_send` posts to one of T3's own
 * agent threads, `t3_thread_merge_back` copies context between two threads. The table's class is final for these
 * exact names only; a new or renamed tool still gets the name check.
 */
export const T3_NAME_CHECK_EXEMPT: readonly string[] = ["t3_thread_send", "t3_thread_send_attachments", "t3_thread_merge_back"];

/** T3's OAuth scopes that only its "Full access" level grants (shown next to the connection). */
export const T3_FULL_ACCESS_SCOPES: readonly string[] = ["settings:write", "source-control:write"];

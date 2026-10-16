// A synthetic 100-tool catalog across 8 services, modelled on the real MCP servers' names and descriptions,
// and natural-language tasks with the tool that does them. Used by the search-mode eval (broker-search-eval.test.ts).
import type { SearchableTool } from "../server/broker/search/bm25.ts";

type Args = Record<string, string>;

function tool(slug: string, name: string, description: string, args: Args, kind: "read" | "write" | "risky" = "read"): SearchableTool {
  const properties = Object.fromEntries(Object.entries(args).map(([k, d]) => [k, { type: "string", description: d }]));
  return {
    name: `${slug}__${name}`,
    description,
    inputSchema: { type: "object", properties, required: Object.keys(args).slice(0, 1) },
    read: kind === "read",
    risky: kind === "risky",
  };
}

const notion = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("notion", n, d, a, k);
const github = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("github", n, d, a, k);
const slack = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("slack", n, d, a, k);
const linear = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("linear", n, d, a, k);
const gdrive = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("gdrive", n, d, a, k);
const stripe = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("stripe", n, d, a, k);
const whoop = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("whoop", n, d, a, k);
const hubspot = (n: string, d: string, a: Args, k?: "read" | "write" | "risky") => tool("hubspot", n, d, a, k);

export const CATALOG: SearchableTool[] = [
  // Notion
  notion("search", "Search pages and databases in the Notion workspace by title or content.", { query: "Words to look for.", filter: "Limit to pages or databases." }),
  notion("fetch", "Retrieve a Notion page or database by URL or ID and return its content as markdown.", { id: "Page or database URL or ID." }),
  notion("create_pages", "Create one or more pages, optionally inside a parent page or database, with properties and markdown content.", { parent: "Parent page or database ID.", pages: "Pages to create: title, properties and content." }, "write"),
  notion("update_page", "Update a page's properties, or replace, insert or append its markdown content.", { page_id: "The page to change.", properties: "Property values to set.", content: "New content." }, "write"),
  notion("move_pages", "Move pages or databases to a new parent page.", { page_ids: "Pages or databases to move.", new_parent: "Destination page ID." }, "write"),
  notion("duplicate_page", "Duplicate a page with its content into the same parent.", { page_id: "The page to copy." }, "write"),
  notion("create_database", "Create a new database with a schema of properties under a parent page.", { parent: "Parent page ID.", title: "Database title.", properties: "Property schema." }, "write"),
  notion("update_database", "Change a database's title, description or property schema.", { database_id: "The database.", title: "New title.", properties: "Schema changes." }, "write"),
  notion("query_database", "Query a database with filters and sorts and return the matching entries.", { database_id: "The database.", filter: "Filter on properties.", sorts: "Sort order." }),
  notion("create_comment", "Add a comment to a page, or reply in an existing discussion.", { page_id: "Page to comment on.", discussion_id: "Discussion to reply in.", text: "Comment text." }, "write"),
  notion("get_comments", "List the comments and discussions on a page.", { page_id: "The page." }),
  notion("get_users", "List the members and guests of the workspace with their names and emails.", { query: "Filter by name or email." }),
  notion("archive_page", "Move a page to the trash.", { page_id: "The page to trash." }, "risky"),

  // GitHub
  github("search_repositories", "Search GitHub repositories by name, topic, language or owner.", { query: "Search query.", page: "Page number." }),
  github("get_file_contents", "Get the contents of a file or directory from a repository at a branch, tag or commit.", { owner: "Repository owner.", repo: "Repository name.", path: "File path.", ref: "Branch, tag or SHA." }),
  github("create_or_update_file", "Create or update a single file in a repository with a commit message.", { owner: "Owner.", repo: "Repository.", path: "File path.", content: "New file content.", message: "Commit message.", branch: "Branch." }, "write"),
  github("search_code", "Search source code across GitHub repositories for symbols, strings or patterns.", { query: "Code search query, e.g. a function name." }),
  github("list_issues", "List issues in a repository, filtered by state, labels or assignee.", { owner: "Owner.", repo: "Repository.", state: "open, closed or all.", labels: "Label names." }),
  github("get_issue", "Get one issue of a repository by number, with its body and labels.", { owner: "Owner.", repo: "Repository.", issue_number: "Issue number." }),
  github("create_issue", "Open a new issue in a repository with a title, body, labels and assignees.", { owner: "Owner.", repo: "Repository.", title: "Issue title.", body: "Description." }, "write"),
  github("update_issue", "Edit an issue: title, body, state (close or reopen), labels or assignees.", { owner: "Owner.", repo: "Repository.", issue_number: "Issue number.", state: "open or closed." }, "write"),
  github("add_issue_comment", "Add a comment to an issue or pull request.", { owner: "Owner.", repo: "Repository.", issue_number: "Issue or PR number.", body: "Comment text." }, "write"),
  github("list_pull_requests", "List pull requests in a repository, filtered by state, base or head branch.", { owner: "Owner.", repo: "Repository.", state: "open, closed or all." }),
  github("get_pull_request_diff", "Get the diff of a pull request: the changed files and lines.", { owner: "Owner.", repo: "Repository.", pull_number: "PR number." }),
  github("create_pull_request", "Open a pull request from a head branch into a base branch.", { owner: "Owner.", repo: "Repository.", title: "PR title.", head: "Head branch.", base: "Base branch." }, "write"),
  github("merge_pull_request", "Merge a pull request (merge, squash or rebase).", { owner: "Owner.", repo: "Repository.", pull_number: "PR number.", merge_method: "merge, squash or rebase." }, "risky"),
  github("create_branch", "Create a branch in a repository from an existing branch.", { owner: "Owner.", repo: "Repository.", branch: "New branch name.", from_branch: "Source branch." }, "write"),

  // Slack
  slack("list_channels", "List the public channels in the Slack workspace with their topics and member counts.", { limit: "How many channels." }),
  slack("get_channel_history", "Get recent messages posted in a channel.", { channel_id: "The channel.", limit: "How many messages." }),
  slack("get_thread_replies", "Get all replies in a message thread.", { channel_id: "The channel.", thread_ts: "Timestamp of the parent message." }),
  slack("post_message", "Post a new message to a Slack channel.", { channel_id: "The channel.", text: "Message text." }, "risky"),
  slack("reply_to_thread", "Reply to a specific message thread in a channel.", { channel_id: "The channel.", thread_ts: "Parent message timestamp.", text: "Reply text." }, "risky"),
  slack("add_reaction", "Add an emoji reaction to a message.", { channel_id: "The channel.", timestamp: "Message timestamp.", reaction: "Emoji name, e.g. thumbsup." }, "write"),
  slack("search_messages", "Search messages across the workspace by keywords, sender or channel.", { query: "Search terms." }),
  slack("get_users", "List the people in the workspace with their basic profile information.", { limit: "How many users." }),
  slack("get_user_profile", "Get a user's detailed profile: title, phone, time zone and status.", { user_id: "The user." }),
  slack("set_channel_topic", "Set the topic of a channel.", { channel_id: "The channel.", topic: "New topic." }, "write"),
  slack("schedule_message", "Schedule a message to be posted to a channel at a later time.", { channel_id: "The channel.", text: "Message text.", post_at: "Unix time to post." }, "risky"),
  slack("upload_file", "Upload a file and share it in a channel.", { channel_id: "The channel.", filename: "File name.", content: "File content." }, "risky"),

  // Linear
  linear("list_issues", "List issues in the workspace, filtered by team, assignee, status or label.", { team: "Team key.", assignee: "User.", state: "Workflow status." }),
  linear("get_issue", "Get the details of an issue by its identifier, e.g. ENG-123.", { id: "Issue identifier." }),
  linear("create_issue", "Create a new issue (ticket) in a team, with title, description, priority and assignee.", { team: "Team.", title: "Title.", description: "Markdown description.", priority: "0-4." }, "write"),
  linear("update_issue", "Update an issue: status, assignee, priority, estimate, labels or project.", { id: "Issue identifier.", state: "New workflow status, e.g. Done.", assignee: "User." }, "write"),
  linear("list_projects", "List projects with their status, lead and target date.", { team: "Team." }),
  linear("get_project", "Get a project's details, milestones and progress.", { id: "Project ID." }),
  linear("create_project", "Create a new project for a team.", { name: "Project name.", team: "Team.", target_date: "Target date." }, "write"),
  linear("list_teams", "List the teams in the Linear workspace.", {}),
  linear("list_cycles", "List a team's cycles (sprints): current, upcoming and past, with their issues.", { team: "Team." }),
  linear("create_comment", "Comment on an issue.", { issue_id: "Issue identifier.", body: "Markdown comment." }, "write"),
  linear("list_issue_statuses", "List the workflow states (statuses) available to a team.", { team: "Team." }),
  linear("list_users", "List the users in the Linear workspace.", {}),

  // Google Drive
  gdrive("search_files", "Search files in Google Drive by name, content, type or owner.", { query: "Search terms.", mime_type: "Limit to a file type, e.g. presentation." }),
  gdrive("get_file", "Get a file's metadata: name, owner, sharing and last modified time.", { file_id: "The file." }),
  gdrive("read_document", "Read the text content of a Google Doc.", { document_id: "The document." }),
  gdrive("read_spreadsheet", "Read cell values from a range of a Google Sheets spreadsheet.", { spreadsheet_id: "The spreadsheet.", range: "A1 range, e.g. Sheet1!B:B." }),
  gdrive("update_spreadsheet", "Write values into a range of cells in a Google Sheets spreadsheet.", { spreadsheet_id: "The spreadsheet.", range: "A1 range.", values: "Rows of values." }, "write"),
  gdrive("create_document", "Create a new Google Doc with a title and optional initial text.", { title: "Document title.", content: "Initial text." }, "write"),
  gdrive("append_to_document", "Append text to the end of a Google Doc.", { document_id: "The document.", text: "Text to add." }, "write"),
  gdrive("create_folder", "Create a folder in Google Drive.", { name: "Folder name.", parent_id: "Parent folder." }, "write"),
  gdrive("move_file", "Move a file into another Drive folder.", { file_id: "The file.", folder_id: "Destination folder." }, "write"),
  gdrive("share_file", "Share a file with people by email, as viewer, commenter or editor.", { file_id: "The file.", email: "Who to share with.", role: "viewer, commenter or editor." }, "risky"),
  gdrive("delete_file", "Move a file to the Drive trash.", { file_id: "The file." }, "risky"),
  gdrive("list_recent_files", "List the files you opened or edited most recently.", { limit: "How many files." }),
  gdrive("export_pdf", "Export a Google Docs, Sheets or Slides file as a PDF.", { file_id: "The file." }),

  // Stripe
  stripe("list_customers", "List customers, optionally filtered by email.", { email: "Customer email.", limit: "How many." }),
  stripe("create_customer", "Create a customer with a name and email.", { name: "Customer name.", email: "Email." }, "write"),
  stripe("retrieve_balance", "Retrieve the current account balance: available and pending funds by currency.", {}),
  stripe("list_payment_intents", "List payment intents (charges in progress or completed) for a customer.", { customer: "Customer ID.", limit: "How many." }),
  stripe("create_invoice", "Create a draft invoice for a customer.", { customer: "Customer ID.", description: "What it's for.", days_until_due: "Days until due." }, "write"),
  stripe("add_invoice_item", "Add a line item with an amount to a draft invoice.", { invoice: "Invoice ID.", amount: "Amount in cents.", description: "Line description." }, "write"),
  stripe("finalize_invoice", "Finalize a draft invoice so it can be paid; Stripe emails it to the customer.", { invoice: "Invoice ID." }, "risky"),
  stripe("list_invoices", "List invoices for a customer, with status and amount due.", { customer: "Customer ID.", status: "draft, open, paid or void." }),
  stripe("create_refund", "Refund a payment, in full or in part.", { payment_intent: "Payment to refund.", amount: "Amount in cents; default the full amount." }, "risky"),
  stripe("list_subscriptions", "List subscriptions for a customer with their plan and status.", { customer: "Customer ID." }),
  stripe("cancel_subscription", "Cancel a customer's subscription, at once or at the period end.", { subscription: "Subscription ID.", at_period_end: "Cancel when the period ends." }, "risky"),
  stripe("create_payment_link", "Create a shareable payment link for a price, so anyone can pay online.", { price: "Price ID.", quantity: "Quantity." }, "write"),
  stripe("list_products", "List products and their prices.", { active: "Only active products." }),

  // WHOOP
  whoop("get_today", "A summary of today: recovery, strain and last night's sleep.", {}),
  whoop("get_recovery", "Recovery scores by day: recovery %, resting heart rate and HRV.", { start: "Start date.", end: "End date." }),
  whoop("get_sleep", "Sleep records: time in bed, sleep stages, performance and respiratory rate.", { start: "Start date.", end: "End date." }),
  whoop("get_cycles", "Physiological cycles (days) with day strain, kilojoules and average heart rate.", { start: "Start date.", end: "End date." }),
  whoop("get_workouts", "Workouts with sport, strain, heart rate zones and distance.", { start: "Start date.", end: "End date." }),
  whoop("get_body_measurement", "Body measurements: height, weight and max heart rate.", {}),
  whoop("get_profile", "The member's profile: name and email.", {}),
  whoop("get_hrv_trend", "Heart rate variability trend over recent weeks.", { weeks: "How many weeks." }),

  // HubSpot
  hubspot("search_contacts", "Search CRM contacts by name, email, company or phone.", { query: "Search terms." }),
  hubspot("get_contact", "Get a contact's properties: email, phone, company, lifecycle stage and owner.", { contact_id: "The contact." }),
  hubspot("create_contact", "Create a contact in the CRM with name, email, company and phone.", { firstname: "First name.", lastname: "Last name.", email: "Email.", company: "Company." }, "write"),
  hubspot("update_contact", "Update a contact's properties.", { contact_id: "The contact.", properties: "Properties to set." }, "write"),
  hubspot("search_companies", "Search companies by name or domain.", { query: "Name or domain." }),
  hubspot("create_company", "Create a company record with name and domain.", { name: "Company name.", domain: "Website domain." }, "write"),
  hubspot("list_deals", "List deals in the pipeline with amount, stage and close date.", { pipeline: "Pipeline.", stage: "Deal stage." }),
  hubspot("create_deal", "Create a deal with an amount, stage and associated company.", { name: "Deal name.", amount: "Amount.", stage: "Pipeline stage." }, "write"),
  hubspot("update_deal_stage", "Move a deal to another pipeline stage, e.g. closed won or closed lost.", { deal_id: "The deal.", stage: "New stage." }, "write"),
  hubspot("log_note", "Add a note to the timeline of a contact, company or deal, e.g. a summary of a call.", { object_id: "Contact, company or deal.", body: "Note text." }, "write"),
  hubspot("create_task", "Create a follow-up task with a due date, assigned to an owner and linked to a record.", { title: "Task title.", due_date: "When it's due.", object_id: "Linked record." }, "write"),
  hubspot("delete_contact", "Delete a contact from the CRM.", { contact_id: "The contact." }, "risky"),
];

/** A task in the user's words and the tool(s) that do it (more than one when either is a right answer). */
export interface EvalTask {
  task: string;
  expected: string[];
}

export const TASKS: EvalTask[] = [
  { task: "find the Notion page about our Q3 roadmap", expected: ["notion__search"] },
  { task: "add a new entry to the reading list database in Notion", expected: ["notion__create_pages"] },
  { task: "leave a comment on the onboarding doc in Notion", expected: ["notion__create_comment"] },
  { task: "who are the members of our Notion workspace", expected: ["notion__get_users"] },
  { task: "get the tasks database items that are due this week", expected: ["notion__query_database"] },
  { task: "open GitHub issue 123 in the api repo", expected: ["github__get_issue"] },
  { task: "file a bug on GitHub about the login crash", expected: ["github__create_issue"] },
  { task: "show me what changed in pull request 42", expected: ["github__get_pull_request_diff"] },
  { task: "merge the approved pull request", expected: ["github__merge_pull_request"] },
  { task: "look for usages of parseConfig across the code", expected: ["github__search_code"] },
  { task: "list the open pull requests in the web repo", expected: ["github__list_pull_requests"] },
  { task: "start a new branch for the dark mode feature", expected: ["github__create_branch"] },
  { task: "post an update in the general Slack channel", expected: ["slack__post_message"] },
  { task: "what has been said in the engineering channel today", expected: ["slack__get_channel_history"] },
  { task: "react with a thumbs up emoji to that Slack message", expected: ["slack__add_reaction"] },
  { task: "find Slack messages that mention the outage", expected: ["slack__search_messages"] },
  { task: "reply in the Slack thread about the release", expected: ["slack__reply_to_thread"] },
  { task: "change the topic of the support channel", expected: ["slack__set_channel_topic"] },
  { task: "create a Linear ticket for the flaky test", expected: ["linear__create_issue"] },
  { task: "mark Linear issue ENG-42 as done", expected: ["linear__update_issue"] },
  { task: "which Linear projects is the team working on", expected: ["linear__list_projects"] },
  { task: "what's in the current sprint", expected: ["linear__list_cycles"] },
  { task: "read column B of the budget spreadsheet", expected: ["gdrive__read_spreadsheet"] },
  { task: "share the proposal doc with bob@example.com", expected: ["gdrive__share_file"] },
  { task: "find the slide deck from last week's offsite in Drive", expected: ["gdrive__search_files"] },
  { task: "write the totals into the finance sheet", expected: ["gdrive__update_spreadsheet"] },
  { task: "make a new Google Doc for the meeting notes", expected: ["gdrive__create_document"] },
  { task: "export the contract as a PDF", expected: ["gdrive__export_pdf"] },
  { task: "refund the customer's last payment", expected: ["stripe__create_refund"] },
  { task: "how much money is available in our Stripe account", expected: ["stripe__retrieve_balance"] },
  { task: "cancel this customer's subscription", expected: ["stripe__cancel_subscription"] },
  { task: "bill Acme for the consulting work with an invoice", expected: ["stripe__create_invoice", "stripe__finalize_invoice"] },
  { task: "create a payment link for the workshop ticket", expected: ["stripe__create_payment_link"] },
  { task: "how well did I sleep last night", expected: ["whoop__get_sleep", "whoop__get_today"] },
  { task: "what is my recovery score today", expected: ["whoop__get_recovery", "whoop__get_today"] },
  { task: "list my workouts this week with their strain", expected: ["whoop__get_workouts"] },
  { task: "what's my current weight on WHOOP", expected: ["whoop__get_body_measurement"] },
  { task: "add Jane Doe from Initech as a new contact in the CRM", expected: ["hubspot__create_contact"] },
  { task: "move the Initech deal to closed won", expected: ["hubspot__update_deal_stage"] },
  { task: "log a note about today's call with the customer", expected: ["hubspot__log_note"] },
  { task: "look up the phone number of our contact at Globex", expected: ["hubspot__search_contacts", "hubspot__get_contact"] },
  { task: "remind me to follow up with the lead next Tuesday", expected: ["hubspot__create_task"] },
];

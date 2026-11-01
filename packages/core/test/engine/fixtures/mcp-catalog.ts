/**
 * A catalog of 45 MCP tools in the style of the GitHub, Notion and calendar
 * servers, for the ToolSearch ranker and the deferred-schema engine test.
 */
type Prop = { type: string; description: string; enum?: string[] };
export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Prop>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; title?: string };
}

const s = (description: string): Prop => ({ type: 'string', description });
const n = (description: string): Prop => ({ type: 'number', description });
const repo = { owner: s('Repository owner (user or organization)'), repo: s('Repository name') };

function tool(name: string, description: string, properties: Record<string, Prop>, required: string[] = [], readOnly = false): CatalogTool {
  return { name, description, inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: readOnly } };
}

export const CATALOG: CatalogTool[] = [
  tool('create_issue', 'Create a new issue in a GitHub repository with a title, body, labels and assignees.', { ...repo, title: s('Issue title'), body: s('Issue body in markdown'), labels: s('Comma separated labels') }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get the details of an issue by its number, with its labels, state and assignees.', { ...repo, issue_number: n('Issue number') }, ['owner', 'repo', 'issue_number'], true),
  tool('list_issues', 'List issues in a repository, filtered by state, labels or assignee.', { ...repo, state: s('open, closed or all'), labels: s('Labels to filter by') }, ['owner', 'repo'], true),
  tool('update_issue', 'Update the title, body, state or labels of an existing issue.', { ...repo, issue_number: n('Issue number'), state: s('open or closed') }, ['owner', 'repo', 'issue_number']),
  tool('add_issue_comment', 'Add a comment to an issue or a pull request conversation.', { ...repo, issue_number: n('Issue or PR number'), body: s('Comment text') }, ['owner', 'repo', 'issue_number', 'body']),
  tool('search_issues', 'Search issues and pull requests across GitHub with the issue search syntax.', { q: s('Search query') }, ['q'], true),
  tool('create_pull_request', 'Open a new pull request from a head branch into a base branch.', { ...repo, title: s('PR title'), head: s('Branch with the changes'), base: s('Branch to merge into') }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Get a pull request by number: title, state, mergeable, head and base.', { ...repo, pull_number: n('Pull request number') }, ['owner', 'repo', 'pull_number'], true),
  tool('list_pull_requests', 'List pull requests in a repository by state and base branch.', { ...repo, state: s('open, closed or all') }, ['owner', 'repo'], true),
  tool('merge_pull_request', 'Merge a pull request with the merge, squash or rebase method.', { ...repo, pull_number: n('Pull request number'), merge_method: s('merge, squash or rebase') }, ['owner', 'repo', 'pull_number']),
  tool('get_pull_request_diff', 'Get the unified diff of a pull request.', { ...repo, pull_number: n('Pull request number') }, ['owner', 'repo', 'pull_number'], true),
  tool('get_pull_request_files', 'List the files changed in a pull request with additions and deletions.', { ...repo, pull_number: n('Pull request number') }, ['owner', 'repo', 'pull_number'], true),
  tool('create_pull_request_review', 'Submit a review on a pull request: approve, request changes or comment.', { ...repo, pull_number: n('Pull request number'), event: s('APPROVE, REQUEST_CHANGES or COMMENT') }, ['owner', 'repo', 'pull_number']),
  tool('request_reviewers', 'Request reviewers for a pull request.', { ...repo, pull_number: n('Pull request number'), reviewers: s('Logins to request') }, ['owner', 'repo', 'pull_number']),
  tool('get_file_contents', 'Get the contents of a file or a directory listing from a repository at a ref.', { ...repo, path: s('File path in the repository'), ref: s('Branch, tag or commit') }, ['owner', 'repo', 'path'], true),
  tool('create_or_update_file', 'Create or update a single file in a repository with a commit message.', { ...repo, path: s('File path'), content: s('New file content'), message: s('Commit message') }, ['owner', 'repo', 'path', 'content', 'message']),
  tool('delete_file', 'Delete a file from a repository with a commit message.', { ...repo, path: s('File path'), message: s('Commit message') }, ['owner', 'repo', 'path', 'message']),
  tool('push_files', 'Push several files to a branch in one commit.', { ...repo, branch: s('Branch name'), message: s('Commit message') }, ['owner', 'repo', 'branch', 'message']),
  tool('list_commits', 'List commits on a branch or path, newest first, with authors and messages.', { ...repo, sha: s('Branch or commit to start from'), path: s('Only commits touching this path') }, ['owner', 'repo'], true),
  tool('get_commit', 'Get one commit by SHA with its diff stats and changed files.', { ...repo, sha: s('Commit SHA') }, ['owner', 'repo', 'sha'], true),
  tool('create_branch', 'Create a new branch from an existing branch or commit.', { ...repo, branch: s('New branch name'), from_branch: s('Source branch') }, ['owner', 'repo', 'branch']),
  tool('list_branches', 'List the branches of a repository.', { ...repo }, ['owner', 'repo'], true),
  tool('list_tags', 'List the git tags of a repository.', { ...repo }, ['owner', 'repo'], true),
  tool('get_latest_release', 'Get the latest published release of a repository with its notes and assets.', { ...repo }, ['owner', 'repo'], true),
  tool('list_releases', 'List the releases of a repository.', { ...repo }, ['owner', 'repo'], true),
  tool('search_code', 'Search code across repositories for functions, symbols or text.', { q: s('Code search query') }, ['q'], true),
  tool('search_repositories', 'Search GitHub repositories by name, topic or language.', { query: s('Search query') }, ['query'], true),
  tool('create_repository', 'Create a new repository for the user or an organization.', { name: s('Repository name'), private: s('true or false') }, ['name']),
  tool('fork_repository', 'Fork a repository into your account or an organization.', { ...repo }, ['owner', 'repo']),
  tool('list_workflow_runs', 'List GitHub Actions workflow runs with their status and conclusion.', { ...repo, workflow_id: s('Workflow file or id') }, ['owner', 'repo'], true),
  tool('get_job_logs', 'Get the logs of a GitHub Actions job, for example a failed CI job.', { ...repo, job_id: n('Job id') }, ['owner', 'repo', 'job_id'], true),
  tool('rerun_workflow_run', 'Re-run a GitHub Actions workflow run, or only its failed jobs.', { ...repo, run_id: n('Run id'), failed_only: s('true to rerun only failed jobs') }, ['owner', 'repo', 'run_id']),
  tool('list_labels', 'List the labels defined in a repository.', { ...repo }, ['owner', 'repo'], true),
  tool('get_me', 'Get the authenticated GitHub user.', {}, [], true),
  tool('search_users', 'Search GitHub users by login, name or location.', { q: s('User search query') }, ['q'], true),
  tool('notion_search', 'Search Notion pages and databases by title or content.', { query: s('Search text') }, ['query'], true),
  tool('notion_create_page', 'Create a new page in Notion under a parent page or database.', { parent_id: s('Parent page or database id'), title: s('Page title'), content: s('Page content in markdown') }, ['parent_id', 'title']),
  tool('notion_update_page', 'Update the properties or content of a Notion page.', { page_id: s('Page id'), content: s('New content') }, ['page_id']),
  tool('notion_get_page', 'Fetch a Notion page with its blocks.', { page_id: s('Page id') }, ['page_id'], true),
  tool('notion_query_database', 'Query a Notion database with filters and sorts and return its rows.', { database_id: s('Database id'), filter: s('Filter as JSON') }, ['database_id'], true),
  tool('notion_create_comment', 'Add a comment to a Notion page or discussion.', { page_id: s('Page id'), text: s('Comment text') }, ['page_id', 'text']),
  tool('calendar_list_events', 'List calendar events between two dates, with attendees and locations.', { start: s('Start date'), end: s('End date') }, ['start', 'end'], true),
  tool('calendar_create_event', 'Create a calendar event with a title, time, attendees and location.', { title: s('Event title'), start: s('Start time'), end: s('End time') }, ['title', 'start', 'end']),
  tool('calendar_cancel_event', 'Cancel a calendar event and notify its attendees.', { event_id: s('Event id') }, ['event_id']),
  tool('sleep', 'Wait for the given number of milliseconds, ignoring cancellation. For timeout tests.', { ms: n('Milliseconds to wait') }, ['ms'], true),
];

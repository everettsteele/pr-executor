# pr-executor

Run Claude Code non-interactively against GitHub PR bodies. Drop into any Node.js project to build a PR-driven autonomous coding queue.

## What it does

- Polls one or more GitHub repos for open PRs
- Runs `claude --print --dangerously-skip-permissions` with the PR body as the prompt
- Auto-merges on success, closes with error comment on failure
- PRs tagged `[needs-review]` are skipped and flagged for human review
- 10-minute timeout per PR
- POST /execute-prs endpoint for manual trigger
- GET /execute-prs/status returns last 50 log lines

## Usage

```bash
npm install
```

Set environment variables:

```bash
GITHUB_TOKEN=your_gh_token
ANTHROPIC_API_KEY=your_anthropic_key
```

Add to your Express app:

```javascript
const { executePRs } = require('./prExecutor');

// Manual trigger
app.post('/execute-prs', async (req, res) => {
  res.json({ status: 'started' });
  await executePRs();
});

// Cron (every hour at :05)
cron.schedule('5 * * * *', () => executePRs());
```

## Requirements

- Node.js 18+
- Claude Code installed globally: `sudo npm install -g @anthropic-ai/claude-code`
- GitHub CLI authenticated: `gh auth login`

## Origin

Built at Meridian. [Read how it works](https://neverstill.llc/tools).

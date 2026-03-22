const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Configure repos via environment variable or pass directly to executePRs().
 *
 * Environment format (JSON array):
 *   REPOS='[{"name":"my-app","path":"/home/user/my-app","owner":"username"}]'
 *
 * Or pass a config object:
 *   executePRs({ repos: [...], logFile: '/path/to/log' })
 */

const DEFAULT_LOG_FILE = path.join(process.cwd(), 'logs', 'pr-executor.log');

function parseReposFromEnv() {
  const envRepos = process.env.REPOS;
  if (!envRepos) return [];
  try {
    return JSON.parse(envRepos);
  } catch {
    console.error('Failed to parse REPOS environment variable — expected JSON array');
    return [];
  }
}

function log(msg, logFile) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) {}
}

function getOpenPRs(repo, logFile) {
  try {
    const out = execSync(
      `gh pr list --repo ${repo.owner}/${repo.name} --state open --json number,title,body,headRefName`,
      { encoding: 'utf8', timeout: 15000 }
    );
    return JSON.parse(out);
  } catch (err) {
    log(`[${repo.name}] Failed to list PRs: ${err.message}`, logFile);
    return [];
  }
}

function runClaudeCode(repoPath, prompt, logFile) {
  return new Promise((resolve) => {
    log(`Running Claude Code in ${repoPath}`, logFile);

    // Pull latest before executing
    try {
      execSync('git pull', { cwd: repoPath, encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      log(`git pull warning: ${e.message}`, logFile);
    }

    const proc = spawn('claude', ['--print', '--dangerously-skip-permissions', prompt], {
      cwd: repoPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // 10-minute timeout per PR
    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ success: false, output: 'Timed out after 10 minutes', stdout, stderr });
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ success: code === 0, output: stdout + stderr, stdout, stderr });
    });
  });
}

function mergePR(repo, prNumber, logFile) {
  try {
    execSync(
      `gh pr merge ${prNumber} --repo ${repo.owner}/${repo.name} --squash --delete-branch`,
      { encoding: 'utf8', timeout: 30000 }
    );
    return true;
  } catch (err) {
    log(`[${repo.name}] Failed to merge PR #${prNumber}: ${err.message}`, logFile);
    return false;
  }
}

function closePRWithComment(repo, prNumber, comment, logFile) {
  try {
    execSync(
      `gh pr comment ${prNumber} --repo ${repo.owner}/${repo.name} --body "${comment.replace(/"/g, "'")}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    execSync(
      `gh pr close ${prNumber} --repo ${repo.owner}/${repo.name}`,
      { encoding: 'utf8', timeout: 15000 }
    );
  } catch (err) {
    log(`[${repo.name}] Failed to close PR #${prNumber}: ${err.message}`, logFile);
  }
}

async function processPR(repo, pr, logFile) {
  log(`[${repo.name}] Processing PR #${pr.number}: ${pr.title}`, logFile);

  if (!pr.body || pr.body.trim().length < 20) {
    log(`[${repo.name}] PR #${pr.number} has no usable body — skipping`, logFile);
    return { skipped: true, reason: 'no body' };
  }

  // Check for [needs-review] flag — skip and surface for human review
  if (pr.body.includes('[needs-review]')) {
    log(`[${repo.name}] PR #${pr.number} flagged [needs-review] — queuing for review`, logFile);
    return { skipped: true, reason: 'needs-review' };
  }

  const result = await runClaudeCode(repo.path, pr.body, logFile);

  if (result.success) {
    log(`[${repo.name}] PR #${pr.number} completed successfully — merging`, logFile);
    const merged = mergePR(repo, pr.number, logFile);
    return { success: true, merged, output: result.output.slice(-500) };
  } else {
    log(`[${repo.name}] PR #${pr.number} failed — closing with error comment`, logFile);
    closePRWithComment(repo, pr.number, `Claude Code failed on this PR. Error: ${result.output.slice(-300)}`, logFile);
    return { success: false, output: result.output.slice(-500) };
  }
}

async function executePRs(config = {}) {
  const repos = config.repos || parseReposFromEnv();
  const logFile = config.logFile || DEFAULT_LOG_FILE;

  if (repos.length === 0) {
    log('No repos configured. Set REPOS env var or pass repos in config.', logFile);
    return [];
  }

  log('=== PR Executor run started ===', logFile);
  const results = [];

  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) {
      log(`[${repo.name}] Repo path not found — skipping`, logFile);
      continue;
    }

    const prs = getOpenPRs(repo, logFile);
    if (prs.length === 0) {
      log(`[${repo.name}] No open PRs`, logFile);
      continue;
    }

    for (const pr of prs) {
      const result = await processPR(repo, pr, logFile);
      results.push({ repo: repo.name, pr: pr.number, title: pr.title, ...result });
    }
  }

  log(`=== PR Executor run complete. Processed: ${results.length} PRs ===`, logFile);
  return results;
}

module.exports = { executePRs };

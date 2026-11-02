import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type {
  GithubIssueView,
  GithubPullRequestView,
  GithubRepositoryView,
} from "@slackboard/shared";

export interface GithubSettings {
  appId: number;
  privateKeyPath: string;
  installationId: number;
  allowedRepos: string[];
}

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

export class GithubNotConfiguredError extends GithubError {
  constructor() {
    super("GitHub App integration is not configured");
    this.name = "GithubNotConfiguredError";
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

export interface CommitFile {
  path: string;
  content: string;
}

const parseRepo = (fullName: string): RepoRef => {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName);
  if (!match) throw new GithubError(`Invalid repository name: ${fullName}`);
  return { owner: match[1]!, repo: match[2]!, fullName };
};

const safeFile = (path: string): void => {
  if (!path || path.includes("\0") || path.startsWith("/") || path.includes("\\")) {
    throw new GithubError(`Invalid repository path: ${path}`);
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new GithubError(`Repository path escapes the repository: ${path}`);
  }
};

export class GithubService {
  private octokit?: Octokit;

  constructor(private readonly settings: GithubSettings | undefined) {}

  get configured(): boolean {
    return Boolean(this.settings);
  }

  private settingsOrThrow(): GithubSettings {
    if (!this.settings) throw new GithubNotConfiguredError();
    return this.settings;
  }

  private async client(): Promise<Octokit> {
    if (this.octokit) return this.octokit;
    const settings = this.settingsOrThrow();
    let privateKey: string;
    try {
      privateKey = await readFile(settings.privateKeyPath, "utf8");
    } catch (error) {
      throw new GithubError(`Cannot read GitHub App private key: ${(error as Error).message}`);
    }
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: settings.appId,
        privateKey,
        installationId: settings.installationId,
      },
    });
    return this.octokit;
  }

  async assertAllowedRepo(fullName: string): Promise<RepoRef> {
    const ref = parseRepo(fullName);
    const settings = this.settingsOrThrow();
    if (!settings.allowedRepos.includes("*") && !settings.allowedRepos.includes(ref.fullName)) {
      throw new GithubError(`Repository ${ref.fullName} is not in GITHUB_ALLOWED_REPOS`);
    }
    return ref;
  }

  async listRepositories(): Promise<GithubRepositoryView[]> {
    const client = await this.client();
    const settings = this.settingsOrThrow();
    const response = await client.request("GET /installation/repositories", { per_page: 100 });
    return response.data.repositories
      .filter(
        (repository) =>
          settings.allowedRepos.includes("*") ||
          settings.allowedRepos.includes(repository.full_name),
      )
      .map((repository) => ({
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
        htmlUrl: repository.html_url,
      }));
  }

  async listIssues(fullName: string, state: "open" | "closed" | "all" = "open"): Promise<GithubIssueView[]> {
    const ref = await this.assertAllowedRepo(fullName);
    const client = await this.client();
    const response = await client.rest.issues.listForRepo({
      owner: ref.owner,
      repo: ref.repo,
      state,
      per_page: 50,
    });
    return response.data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        htmlUrl: issue.html_url,
        user: issue.user?.login,
      }));
  }

  async listPullRequests(
    fullName: string,
    state: "open" | "closed" | "all" = "open",
  ): Promise<GithubPullRequestView[]> {
    const ref = await this.assertAllowedRepo(fullName);
    const client = await this.client();
    const response = await client.rest.pulls.list({
      owner: ref.owner,
      repo: ref.repo,
      state,
      per_page: 50,
    });
    return response.data.map((pull) => ({
      number: pull.number,
      title: pull.title,
      state: pull.state,
      draft: Boolean(pull.draft),
      htmlUrl: pull.html_url,
      head: pull.head.ref,
      base: pull.base.ref,
    }));
  }

  async getPullRequestDiff(fullName: string, number: number): Promise<string> {
    const ref = await this.assertAllowedRepo(fullName);
    const client = await this.client();
    const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      headers: { accept: "application/vnd.github.v3.diff" },
    });
    return String(response.data);
  }

  async createBranch(fullName: string, branch: string, fromBranch: string): Promise<void> {
    const ref = await this.assertAllowedRepo(fullName);
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes("..")) {
      throw new GithubError("Invalid branch name");
    }
    const client = await this.client();
    const base = await client.rest.git.getRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${fromBranch}`,
    });
    await client.rest.git.createRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `refs/heads/${branch}`,
      sha: base.data.object.sha,
    });
  }

  async commitFiles(
    fullName: string,
    branch: string,
    files: CommitFile[],
    message: string,
  ): Promise<{ commitSha: string }> {
    const ref = await this.assertAllowedRepo(fullName);
    if (files.length === 0) throw new GithubError("No files supplied");
    for (const file of files) safeFile(file.path);
    const client = await this.client();
    const branchRef = await client.rest.git.getRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${branch}`,
    });
    const headSha = branchRef.data.object.sha;
    const headCommit = await client.rest.git.getCommit({
      owner: ref.owner,
      repo: ref.repo,
      commit_sha: headSha,
    });
    const blobs = await Promise.all(
      files.map(async (file) => {
        const blob = await client.rest.git.createBlob({
          owner: ref.owner,
          repo: ref.repo,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        });
        return { path: file.path, sha: blob.data.sha };
      }),
    );
    const tree = await client.rest.git.createTree({
      owner: ref.owner,
      repo: ref.repo,
      base_tree: headCommit.data.tree.sha,
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      })),
    });
    const commit = await client.rest.git.createCommit({
      owner: ref.owner,
      repo: ref.repo,
      message,
      tree: tree.data.sha,
      parents: [headSha],
    });
    await client.rest.git.updateRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${branch}`,
      sha: commit.data.sha,
      force: false,
    });
    return { commitSha: commit.data.sha };
  }

  async createDraftPullRequest(
    fullName: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; url: string }> {
    const ref = await this.assertAllowedRepo(fullName);
    const client = await this.client();
    const response = await client.rest.pulls.create({
      owner: ref.owner,
      repo: ref.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: true,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async createCloneToken(fullName: string): Promise<{ token: string; cloneUrl: string }> {
    const ref = await this.assertAllowedRepo(fullName);
    const settings = this.settingsOrThrow();
    const auth = createAppAuth({
      appId: settings.appId,
      privateKey: await readFile(settings.privateKeyPath, "utf8"),
      installationId: settings.installationId,
    });
    const result = await auth({
      type: "installation",
      repositoryNames: [ref.repo],
      permissions: { contents: "read", metadata: "read" },
    });
    return {
      token: result.token,
      cloneUrl: `https://x-access-token:${result.token}@github.com/${ref.fullName}.git`,
    };
  }
}

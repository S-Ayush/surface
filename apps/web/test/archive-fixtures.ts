// The archive page's server (PLAN-015 S4) for the web tests: issues as `issue.list` and
// `issue.listDeleted` answer them, and a fake `IssueApi` that records what it was asked and
// answers from what the test set. Not a test file.
import type { OperationAnswer } from '../src/features/files/operation.js';
import type { DeletedIssuePage, IssueApi, IssuePage } from '../src/features/issues/issue-api.js';
import type { IssueOutput } from '../src/features/issues/issue-view.js';

export type SummaryNode = IssuePage['nodes'][number];
export type DeletedNode = DeletedIssuePage['nodes'][number];

/** An issue summary of team `teamKey`; `n` makes its id and number. */
export function summary(
  n: number,
  extra: Partial<SummaryNode> & { teamKey?: string } = {},
): SummaryNode {
  const teamKey = extra.teamKey ?? 'ENG';
  return {
    id: `0192f0c1-7e5a-7b3c-9d4e-${n.toString(16).padStart(12, '0')}`,
    identifier: `${teamKey}-${String(n)}`,
    teamKey,
    title: `Issue ${String(n)}`,
    status: {
      id: '0192f0c1-7e5a-7b3c-9d4e-0000000000c1',
      name: 'Done',
      category: 'completed',
    },
    priority: 0,
    assignee: null,
    labels: [],
    estimate: null,
    dueDate: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    completedAt: '2026-10-02T10:00:00.000Z',
    archivedAt: null,
    deletedAt: null,
    deletedBy: null,
    url: `http://localhost/issue/${teamKey}-${String(n)}`,
    ...extra,
  };
}

/** A deleted issue as `issue.listDeleted` answers it: `deletedAt` plus 720 h. */
export function deletedNode(n: number, deletedAt: string, extra: Partial<SummaryNode> = {}) {
  const purgeAfter = new Date(new Date(deletedAt).getTime() + 720 * 3_600_000).toISOString();
  return { ...summary(n, { deletedAt, ...extra }), purgeAfter };
}

const page = <T>(nodes: readonly T[], hasNextPage = false, endCursor: string | null = null) => ({
  ok: true as const,
  result: { nodes: [...nodes], pageInfo: { hasNextPage, endCursor } },
});

export type ApiCall = { readonly op: string; readonly input: unknown };

/** Answers each query from what the test set; `unreachable` makes every one fail like offline. */
export class FakeIssueApi implements IssueApi {
  readonly calls: ApiCall[] = [];
  archived: SummaryNode[] = [];
  deleted: DeletedNode[] = [];
  archivedCount = 0;
  unreachable = false;
  /** `issue.get`'s answer; never answers by default. */
  getAnswer: (ref: string) => Promise<OperationAnswer<IssueOutput>> = () =>
    new Promise(() => undefined);

  #failed<T>(): Promise<OperationAnswer<T>> {
    return Promise.resolve({ ok: false, code: 'UNREACHABLE', message: 'offline' });
  }

  get = (ref: string): Promise<OperationAnswer<IssueOutput>> => {
    this.calls.push({ op: 'issue.get', input: ref });
    return this.getAnswer(ref);
  };

  list: NonNullable<IssueApi['list']> = (input) => {
    this.calls.push({ op: 'issue.list', input });
    return this.unreachable ? this.#failed() : Promise.resolve(page(this.archived));
  };

  listDeleted: NonNullable<IssueApi['listDeleted']> = (input) => {
    this.calls.push({ op: 'issue.listDeleted', input });
    return this.unreachable ? this.#failed() : Promise.resolve(page(this.deleted));
  };

  count: NonNullable<IssueApi['count']> = (input) => {
    this.calls.push({ op: 'issue.count', input });
    return this.unreachable
      ? this.#failed()
      : Promise.resolve({ ok: true, result: { count: this.archivedCount } });
  };
}

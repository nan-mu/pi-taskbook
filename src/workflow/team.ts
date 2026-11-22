import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { queryProjectFacts, maxFactMatches } from "../facts/query.ts";
import { readTopicFacts, taskFactLabel } from "../facts/taskbook-intake.ts";
import { readProjectMemory } from "../facts/project-memory.ts";
import { resolveModel, roleSelection, type RoleSelection } from "../models/config.ts";
import { inspectionTool, type Inspection } from "../review/reviewer.ts";
import { git, workspace } from "../taskbook/document.ts";
import { checkpoint, cleanRevision, type Run } from "./checkpoint.ts";
import { archiveDesign } from "./design-archive.ts";
import { answerDesigner, designerTurns, settleDesignerTurn, startDesigner, type DesignerState } from "./designer/v0.2.ts";
import { implementerTurn, playbooks, resumeImplementer, reworkImplementer, settleImplementerTurn, startImplementer,
  type ImplementerState, type Playbook } from "./implement/v0.1.ts";
import { readRunContext } from "./phase-input.ts";
import type { FactPlacement } from "./register-facts.ts";
import { answerReviewUser, reviewTurns, settleReviewTurn, startReviewFlow, type ReviewFlow } from "./review/flow.ts";
import { isCandidateReceipt, type registerSubagentTool, type CommandReceipt, type Seat, type WorkerReceipt, type WorkTurn } from "./subagent.ts";
import { methodDefinition } from "../methods/tool.ts";
import type { PullRequestAction } from "../integrations/github-handoff.ts";

export type DraftFact = {id: string; text: string; source: string; seat: Seat; work: string};
export type Team = {
  design?: DesignerState;
  implement?: ImplementerState;
  review?: ReviewFlow;
  receipts?: WorkerReceipt[];
  commands?: CommandReceipt[];
  drafts?: DraftFact[];
  designBase?: string;
  archiveRevision?: string;
  trialBase?: string;
  registered?: {revision: string; diff: string};
  placements?: FactPlacement[];
  handoff?: string;
  pullRequest?: PullRequestAction;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const answerSchema = Type.Union([
  Type.Object({kind: Type.Literal("answer"), answer: Type.String({minLength: 1, pattern: "\\S"})}, {additionalProperties: false}),
  Type.Object({kind: Type.Literal("ask-user"), question: Type.String({minLength: 1, pattern: "\\S"})}, {additionalProperties: false}),
]);
const leadConsult = readFileSync(new URL("../../prompts/lead-implement-consult.md", import.meta.url), "utf8").trim();
const factParameters = Type.Object({
  query: Type.String({minLength: 1, maxLength: 240}),
  label: Type.Optional(Type.String({minLength: 1, maxLength: 100})),
  limit: Type.Optional(Type.Integer({minimum: 1, maximum: maxFactMatches})),
  offset: Type.Optional(Type.Integer({minimum: 0})),
}, {additionalProperties: false});
const reviewReply = Type.Object({
  kind: Type.String(),
  draftFacts: Type.Optional(Type.Array(Type.Object({id: Type.String(), evidence: Type.Array(Type.String())}))),
  evidence: Type.Optional(Type.Array(Type.String())),
  findings: Type.Optional(Type.Array(Type.Object({evidence: Type.Array(Type.String()), factId: Type.Optional(Type.String())}))),
});
const needsUserResult = Type.Object({kind: Type.Literal("needs-user")});

function factTool(run: Run, lookup: Set<string>): ToolDefinition<typeof factParameters> {
  return {
    name: "taskbook_query_facts", label: "Query facts",
    description: "Search .fact by project label, exact fact ID or keywords. Use draft, designer, implementer, a seat, or an exact work state as a label to page through matching draft facts. The result includes nextOffset when more drafts match.",
    parameters: factParameters,
    async execute(_id, {query, label, limit = 5, offset = 0}) {
      const key = (label ?? query).trim().toLowerCase();
      const drafts = run.state.team?.drafts ?? [];
      const matches = drafts.filter(fact => {
        const tags = ["draft", fact.seat, fact.work, fact.seat === "implementer" ? "implementer" : "designer"];
        if (fact.id === key) return true;
        if (label) return tags.includes(key) && (query === label || fact.text.toLowerCase().includes(query.toLowerCase()));
        return tags.includes(key) || fact.text.toLowerCase().includes(key);
      });
      const page = matches.slice(offset, offset + limit);
      page.forEach(match => lookup.add(match.id));
      const isDraftKey = key === "draft" || key.startsWith("draft:") || drafts.some(fact => fact.seat === key || fact.work === key) ||
        ["designer", "implementer", "lead", "member-a", "member-b"].includes(key);
      const project = isDraftKey ? undefined : await queryProjectFacts(run.root, {query, label, limit}, run.state.factView);
      project?.matches.forEach(match => { lookup.add(match.id); lookup.add(match.path + "#" + match.id); });
      const result = {project, drafts: page, nextOffset: offset + page.length < matches.length ? offset + page.length : undefined};
      return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
    },
  };
}

function addDrafts(existing: DraftFact[], facts: readonly {text: string; source: string}[], seat: Seat, work: string) {
  const next = [...existing];
  for (const fact of facts) {
    const content = {text: fact.text.trim(), source: fact.source.trim(), seat, work};
    const id = "draft:" + hash(content).slice(0, 20);
    if (!next.some(prior => prior.id === id)) next.push({id, ...content});
  }
  return next;
}

function checkFacts(run: Run) {
  const {state, root} = run;
  if (readTopicFacts(root).head !== state.topicFactsHead || readProjectMemory(root).head !== state.approvedProjectHead) {
    throw new Error("事实版本已变化，请恢复任务使用的版本后重试。");
  }
}

function assertCandidate(run: Run, revision: string) {
  if (cleanRevision(run) !== revision) throw new Error("审核期间候审提交发生变化。");
}

export function selectedPlaybook(markdown: string): Playbook | undefined {
  const header = markdown.split(/^## Goal[^\S\r\n]*\r?$/mu, 1)[0];
  const entries = [...header.matchAll(/^Playbook:[ \t]*(\S+)[ \t]*\r?$/gmu)];
  if (!entries.length) return;
  const value = entries[0][1];
  const playbook = Object.keys(playbooks).find(name => name === value) as Playbook | undefined;
  if (entries.length > 1 || !playbook) throw new Error("任务书 Playbook 须唯一且使用有效名称。");
  return playbook;
}

export function resumeTeam(run: Run, answer: string) {
  const {team, pendingQuestion, phase} = run.state;
  if (!team || !pendingQuestion) return false;
  const next = {...team};
  if (phase === "fact-registration" || phase === "handoff") {
    checkpoint(run, {...run.state, pendingQuestion: undefined,
      userAnswers: [...(run.state.userAnswers ?? []), {question: pendingQuestion.question, answer}]});
    return true;
  }
  if (phase === "review" && team.review?.kind === "needs-user") next.review = answerReviewUser(team.review, answer);
  else if (phase === "review" && team.review?.kind === "rework" && team.implement?.kind === "handoff") {
    next.implement = reworkImplementer(team.implement, JSON.stringify({findings: team.review.findings, userDecision: answer}));
    checkpoint(run, {...run.state, team: next, phase: "implement", revision: undefined, candidateId: undefined, pendingQuestion: undefined,
      userAnswers: [...(run.state.userAnswers ?? []), {question: pendingQuestion.question, answer}]});
    return true;
  }
  else if (phase === "design" && team.design?.kind === "paused") next.design = answerDesigner(team.design, answer);
  else if (phase === "implement" && team.implement?.kind === "paused") next.implement = resumeImplementer(team.implement, answer);
  else return false;
  checkpoint(run, {...run.state, team: next, pendingQuestion: undefined,
    userAnswers: [...(run.state.userAnswers ?? []), {question: pendingQuestion.question, answer}]});
  return true;
}

export async function runTeam(run: Run, ctx: ExtensionToolContext, signal: AbortSignal,
  status: (value: string) => void, runWorker: ReturnType<typeof registerSubagentTool>) {
  const id = run.task.digest;
  const persist = (team: Team, patch: Partial<Run["state"]> = {}) => checkpoint(run, {...run.state, ...patch, team});
  const pause = (question: string) => checkpoint(run, {...run.state, pendingQuestion: {question}});
  const pauseForFact = (factId: string, observation: string) => {
    const snapshot = readProjectMemory(run.root);
    const record = snapshot.records[factId];
    checkpoint(run, {...run.state, pendingConflicts: [{factId, observation, projectVersion: record?.version,
      projectHead: record ? snapshot.head : undefined}]});
  };
  const fetchDrafts = (team: Team) => team.drafts ?? [];
  const dispatch = async (seat: Seat, turn: WorkTurn, snapshot: string, options: {
    review?: boolean; cleanContext?: boolean; writable?: boolean; evidence?: boolean;
  } = {}) => {
    const observations: Inspection[] = [];
    const lookedUp = new Set<string>();
    const tools: ToolDefinition[] = [factTool(run, lookedUp)];
    if (!options.writable || options.review) tools.push(inspectionTool({root: run.root,
      base: options.review ? run.state.team?.archiveRevision ?? run.state.base : run.state.base, revision: snapshot}, observations));
    if (!options.review) tools.push(methodDefinition(() => ({phase: seat === "implementer" ? "implement" : "design", type: run.task.type})));
    if (options.evidence) {
      tools.push({
        name: "taskbook_review_evidence", label: "Read candidate verification",
        description: "Read the Implementer's verification and other work records for this particular candidate.",
        parameters: Type.Object({}, {additionalProperties: false}),
        async execute() {
          const implementation = run.state.team?.implement;
          if (implementation?.kind !== "handoff" || run.state.revision !== snapshot) throw new Error("Candidate evidence no longer applies.");
          const commands = (run.state.team?.commands ?? []).filter(command => isCandidateReceipt(command, snapshot));
          const text = JSON.stringify({records: implementation.checkpoint.records, commands});
          return {content: [{type: "text", text}], details: {}};
        },
      });
    }
    const role = seat === "implementer" ? "implement" : seat === "lead" ? "design" : seat === "member-a" ? "designMemberA" : "designMemberB";
    const prior = run.state.team?.receipts?.find(receipt => receipt.seat === seat);
    const route: RoleSelection = prior
      ? {model: resolveModel(ctx, prior.model), thinkingLevel: prior.thinking}
      : roleSelection(ctx, run.root, run.state.routes!, role);
    const reply = await runWorker({run, ctx, seat, turn, route, tools, cleanContext: options.cleanContext || seat === "implementer", signal,
      builtins: options.writable ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : []});
    return {...reply, observations, lookedUp};
  };
  const settledBatch = async <T,>(turns: readonly T[], perform: (turn: T) => Promise<Awaited<ReturnType<typeof dispatch>>>,
    accept: (turn: T, reply: Awaited<ReturnType<typeof dispatch>>) => void, deferUserRequest = false) => {
    const results = await Promise.allSettled(turns.map(perform));
    signal.throwIfAborted();
    workspace(run.root, run.task, run.state.base, run.state.branch);
    checkFacts(run);
    let failure: unknown;
    const acceptedOrder = [...results.entries()];
    if (deferUserRequest) {
      const priority = (result: typeof results[number]) => Number(result.status === "fulfilled" && Value.Check(needsUserResult, result.value.result));
      acceptedOrder.sort(([, left], [, right]) => priority(left) - priority(right));
    }
    for (const [index, result] of acceptedOrder) {
      if (result.status === "rejected") failure ??= result.reason;
      else {
        try { accept(turns[index], result.value); } catch (error) { failure ??= error; }
      }
    }
    if (failure !== undefined) throw failure;
  };

  while (true) {
    signal.throwIfAborted();
    workspace(run.root, run.task, run.state.base, run.state.branch);
    checkFacts(run);
    const {state} = run;
    const team = state.team ?? {};
    const context = readRunContext(run);
    if (state.phase === "design") {
      if (!team.design) {
        const baseline = git(run.root, "rev-parse", "HEAD");
        const observations = state.reports.slice(state.cycleStart ?? 0).findLast(r => r.phase === "fact-check" && r.outcome === "pass")?.factChecks ?? [];
        const userAnswers = state.userAnswers ?? [];
        const factsVersion = hash([state.topicFactsHead, state.approvedProjectHead, state.factView, context.facts, observations, userAnswers]);
        const design = startDesigner({runId: id + ":design:" + (state.plan?.version ?? 0), baseline, factsVersion, observations, userAnswers,
          taskbook: run.task.markdown, facts: context.facts.map(fact => fact.id + " " + fact.text +
            (fact.userDecision ? " (User decision: " + JSON.stringify(fact.userDecision) + ")" : "")),
          targetIds: [...context.goals, ...context.delivery].map(item => item.id)});
        persist({...team, design, designBase: baseline});
        continue;
      }
      if (team.design.kind === "paused") {
        const {question, evidence, factId} = team.design;
        if (factId && context.facts.some(fact => fact.id === factId)) return pauseForFact(factId, question + "\n" + evidence);
        return pause([question, factId, evidence].filter(Boolean).join("\n"));
      }
      if (team.design.kind === "approved") {
        const {candidate, checkpoint: designCheckpoint} = team.design;
        const plan = {...candidate.plan, version: (state.plan?.version ?? 0) + 1};
        const authored = designCheckpoint.drafts.reduce((all, entry) =>
          addDrafts(all, entry.draft.facts.map(text => ({text, source: "Designer draft " + entry.version})), entry.designer, "draft"), fetchDrafts(team));
        const drafts = designCheckpoint.consultations.reduce((all, entry) =>
          addDrafts(all, entry.result.draftFacts, entry.designer, "consult"), authored);
        const archiveRevision = archiveDesign(run.root, run.task, state.base, state.branch, plan, state.taskFacts!, candidate.draft);
        const report = {phase: "design", outcome: "pass", summary: candidate.draft.goal, evidence: [candidate.version],
          plan, planVersion: plan.version} as const;
        persist({...team, drafts, archiveRevision}, {phase: "implement", plan, reports: [...state.reports, {...report, evidence: [...report.evidence]}]});
        continue;
      }
      const turns: (WorkTurn & {designer: Exclude<Seat, "implementer">})[] = designerTurns(team.design);
      status("Design · " + turns.map(turn => turn.designer + "/" + turn.work).join(", "));
      await settledBatch(turns, turn => dispatch(turn.designer, {
        ...turn, prompt: turn.prompt + "\n\n" + "Primary taskbook facts are tagged " + taskFactLabel(run.task) +
          ". Query project facts as needed. For a conflict with an authored fact, check each record's project, applicable revision, and authority. Flag both source locations and the affected design decision for the Lead.",
      }, team.designBase!, {cleanContext: turn.work === "draft"}), (turn, reply) => {
        const current = run.state.team!;
        const design = settleDesignerTurn(current.design!, {id: turn.id, settled: true, result: reply.result});
        if (design !== current.design) persist({...current, design, receipts: [...(current.receipts ?? []), reply.receipt]});
      }, true);
      continue;
    }

    if (state.phase === "implement" || state.phase === "performance") {
      const implementation = team.implement;
      if (!implementation) {
        if (!state.plan) throw new Error("Implement 需要已签署的交付计划。");
        const approved = team.design?.kind === "approved" ? team.design.candidate.draft : undefined;
        const playbook = selectedPlaybook(run.task.markdown);
        const hillclimb = playbook === "hillclimb" ? {target: context.goals.map(item => item.text).join("\n"), minAttempts: 1, maxAttempts: 3} : undefined;
        persist({...team, implement: startImplementer({runId: id + ":implement:" + state.plan.version, taskType: run.task.type,
          taskbook: run.task.markdown + "\n\nApproved design, taskbook fact label, facts and decisions:\n" +
            JSON.stringify({approved, taskFactLabel: taskFactLabel(run.task), facts: state.taskFacts, userAnswers: state.userAnswers}),
          tasks: state.plan.steps.map(step => JSON.stringify(step)), playbook, hillclimb})});
        continue;
      }
      if (implementation.kind === "paused") {
        const {question, evidence, stepId} = implementation;
        if (stepId && !state.plan?.steps.some(step => step.id === stepId)) throw new Error("方案缺口需要引用现行计划的步骤。");
        const turn: WorkTurn = {
          id: implementation.previous.id + ":lead", work: "implement-consult", prompt: leadConsult, schema: answerSchema,
          context: {question, evidence, stepId, goals: context.goals, plan: state.plan, taskFactLabel: taskFactLabel(run.task)},
        };
        status("Implement · Lead Consult");
        await settledBatch([turn], work => dispatch("lead", work, git(run.root, "rev-parse", "HEAD")), (_turn, reply) => {
          const result = reply.result;
          if (!Value.Check(answerSchema, result)) throw new Error("无效的 Lead Consult 答案。");
          const outcome: Static<typeof answerSchema> = result;
          persist({...team, implement: outcome.kind === "answer" ? resumeImplementer(implementation, outcome.answer) : implementation,
            receipts: [...(team.receipts ?? []), reply.receipt]},
            outcome.kind === "ask-user" ? {pendingQuestion: {question: outcome.question + "\n" + evidence}} : {});
        });
        if (run.state.pendingQuestion) return;
        continue;
      }
      if (implementation.kind === "handoff") {
        const revision = cleanRevision(run);
        if (!team.archiveRevision || git(run.root, "diff", "--name-only", team.archiveRevision, revision, "--", ".fact")) {
          throw new Error("Implement 提交更改了项目事实。请将待审核的事实提交为 Draft Facts。");
        }
        const verify = implementation.checkpoint.records.at(-1);
        if (!verify || verify.work !== "verify" || verify.result.kind !== "verified") throw new Error("Implement 交接缺少验证结果。");
        const review = startReviewFlow({runId: id, goals: context.goals,
          candidate: {revision, evidenceVersion: hash([implementation.checkpoint.records, fetchDrafts(team), team.commands])}, previous: team.review});
        const candidateId = randomUUID();
        const summary = verify.result.summary;
        persist({...team, review}, {phase: "review", revision, candidateId,
          reports: [...state.reports, {phase: "implement", outcome: "pass", summary, evidence: verify.result.evidence,
            candidateId, planVersion: state.plan?.version}]});
        continue;
      }
      const turn = implementerTurn(implementation)!;
      const hillclimb = implementation.checkpoint.playbook === "hillclimb";
      const trialBase = hillclimb && turn.work === "choose" ? cleanRevision(run) : team.trialBase;
      status("Implement · " + implementation.checkpoint.playbook + " / " + turn.work);
      await settledBatch([turn], work => dispatch("implementer", {...work, prompt: work.prompt + "\n\n" +
        "Use the approved tasks and primary taskbook facts. Start each implementation slice from a known state, change one independently verifiable behavior, and check it on the candidate before moving on. Resolve local decisions in Consult and send plan or scope decisions to the Lead. " +
        "Keep delivery commits local until Handoff publishes the signed revision. Report durable new knowledge as sourced draft facts. " +
        "Use taskbook_method to load a reference method when needed."},
        git(run.root, "rev-parse", "HEAD"), {writable: true}), (_turn, reply) => {
        const implement = settleImplementerTurn(implementation, {id: turn.id, settled: true, result: reply.result});
        if (implement.kind === "handoff") {
          const revision = cleanRevision(run);
          if (!reply.commands.some(command => !command.failed && isCandidateReceipt(command, revision))) {
            throw new Error("Verify 需要在干净的提交上实际运行一项交付检查。");
          }
        }
        if (hillclimb && trialBase) {
          const keep = Type.Object({kind: Type.Literal("decision"), verdict: Type.Literal("keep")});
          if (Value.Check(keep, reply.result)) {
            const revision = cleanRevision(run);
            if (git(run.root, "rev-list", "--parents", "-n", "1", revision) !== revision + " " + trialBase ||
                !git(run.root, "diff", "--name-only", trialBase, revision)) throw new Error("保留实验需要一条包含实际改动的独立提交。");
          }
          if (turn.work === "rollback" && implement.kind === "working" && implement.work !== "rollback" && implement.work !== "consult" &&
              git(run.root, "diff", "--name-only", trialBase, cleanRevision(run))) {
            throw new Error("实验回退后工作区内容必须与该次实验前一致。");
          }
        }
        const schema = Type.Object({draftFacts: Type.Optional(Type.Array(Type.Object({text: Type.String(), source: Type.String()})))});
        const drafts = Value.Check(schema, reply.result) ? addDrafts(fetchDrafts(team), reply.result.draftFacts ?? [], "implementer", turn.work) : fetchDrafts(team);
        persist({...team, implement, drafts, trialBase, commands: [...(team.commands ?? []), ...reply.commands], receipts: [...(team.receipts ?? []), reply.receipt]});
      });
      continue;
    }

    if (state.phase !== "review") return;
    const review = team.review;
    if (!review || !state.revision) throw new Error("缺少当前候审提交的 Review 检查点。");
    const {revision} = state;
    assertCandidate(run, revision);
    if (review.kind === "needs-user") {
      const protectedFact = review.findings.find(finding => finding.factId && context.facts.some(fact => fact.id === finding.factId));
      if (protectedFact?.factId) return pauseForFact(protectedFact.factId, review.question + "\n" + protectedFact.detail);
      return pause(review.question + "\n" + review.findings.map(finding => finding.detail).join("\n"));
    }
    if (review.kind === "rework") {
      const implementation = team.implement;
      if (implementation?.kind !== "handoff") throw new Error("审核返工需要已交接的 Implementer 会话。");
      const already = state.reports.findLast(report => report.phase === "review" && report.reviewInput === revision && report.outcome === "rework");
      if (already) return pause("同一提交再次被退回。请决定如何推进。\n" + review.summary);
      const report = {phase: "review", outcome: "rework", reviewInput: revision, summary: review.summary, evidence: review.findings.map(finding => finding.detail)} as const;
      const feedback = JSON.stringify({summary: review.summary, findings: review.findings});
      persist({...team, implement: reworkImplementer(implementation, feedback)}, {phase: "implement", revision: undefined,
        candidateId: undefined, reports: [...state.reports, report]});
      continue;
    }
    if (review.kind === "approved") {
      const approvedDrafts = review.draftFacts.filter(fact => fact.decision === "keep");
      const evidence = [revision, ...approvedDrafts.map(fact => fact.id)];
      persist(team, {phase: "fact-registration",
        reports: [...state.reports, {phase: "review", outcome: "pass", summary: review.summary, evidence,
          candidateId: state.candidateId, projectHead: state.approvedProjectHead}]});
      return;
    }
    const turns = reviewTurns(review);
    status("Review · " + turns.map(turn => turn.designer + "/" + turn.work).join(", "));
    await settledBatch(turns, turn => dispatch(turn.designer, {...turn, context: {...turn.context, taskFactLabel: taskFactLabel(run.task)}}, revision, {
      review: true, cleanContext: turn.cleanContext || turn.work.startsWith("initial-"), evidence: true,
    }), (turn, reply) => {
      assertCandidate(run, revision);
      const result = reply.result;
      const freshJudgment = /^(initial|cross)-/u.test(turn.work);
      const drafts = fetchDrafts(team);
      if (!Value.Check(reviewReply, result)) throw new Error("审核结果格式无效。");
      if (freshJudgment) {
        const references = [...(result.evidence ?? []), ...(result.findings ?? []).flatMap(finding => finding.evidence)];
        if (!reply.observations.some(obs => (obs.view === "candidate" || obs.view === "diff") && obs.characters > 0 && references.includes(obs.id))) {
          throw new Error(turn.designer + " 的审核需要引用本轮独立检查的文件或差异。");
        }
        if (drafts.some(draft => !reply.lookedUp.has(draft.id))) {
          throw new Error(turn.designer + " 需要逐条审核本次提交的 Draft Facts。");
        }
      }
      if ((freshJudgment || result.draftFacts !== undefined) && ((result.draftFacts ?? []).length !== drafts.length ||
          drafts.some(draft => !result.draftFacts?.some(item => item.id === draft.id)))) {
        throw new Error("审核意见须涵盖当前提交的全部 Draft Facts。");
      }
      if (result.kind === "approve" && drafts.some(draft => !reply.lookedUp.has(draft.id))) {
        throw new Error("Lead 需要在签署前查询本次全部 Draft Facts。");
      }
      if ((result.findings ?? []).some(finding => finding.factId && !context.facts.some(fact => fact.id === finding.factId) &&
          !reply.lookedUp.has(finding.factId) && !drafts.some(draft => draft.id === finding.factId))) {
        throw new Error("审核报告引用了未核对的事实 ID。");
      }
      for (const finding of result.findings ?? []) {
        const item = context.facts.find(fact => fact.topicFact && (fact.topicFact.id === finding.factId ||
          fact.topicFact.path + "#" + fact.topicFact.id === finding.factId));
        if (item) finding.factId = item.id;
      }
      const current = run.state.team!;
      const next = settleReviewTurn(current.review!, {id: turn.id, settled: true, result});
      if (next !== current.review) persist({...current, review: next, receipts: [...(current.receipts ?? []), reply.receipt]});
    });
  }
}

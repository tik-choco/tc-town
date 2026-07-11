// Conversation evaluation — LLM-as-judge scoring for tc-town sessions.
//
// Ported from tik-choco-lab/agent-conversation's evaluation.py
// (TranscriptEvaluator + CONVERSATION_SCHEMA): after a session, an evaluator
// LLM call scores the transcript against a fixed set of Japanese rubric axes
// and returns strict JSON, which we parse defensively and persist so the UI
// can show a history of past evaluations. STREAMING_SCHEMA is intentionally
// not ported — tc-town has no streaming/broadcast feature.

import { DEFAULT_LLM_PROFILE_ID, type Character, type ChatMessage } from "../types";
import { requestChatCompletion } from "./llm";
import { USER_SPEAKER_ID, type ConversationSession } from "./conversation";

// -----------------------------------------------------------------------------
// Schema (verbatim port of evaluation.py's CONVERSATION_SCHEMA axes)
// -----------------------------------------------------------------------------

export interface EvaluationAxis {
  key: string;
  label: string;
  rubric: string;
}

const EVALUATOR_ROLE = "あなたは会話AIの評価者です。";
const TARGET_LABEL = "評価対象の会話";

/** evaluation.py CONVERSATION_SCHEMA の10軸を日本語ルーブリックごと逐語移植する */
export const CONVERSATION_AXES: readonly EvaluationAxis[] = [
  { key: "memory_score", label: "記憶反映", rubric: "相手が明かした事実や直前までの文脈を自然に反映できているか。" },
  { key: "character_score", label: "キャラクター一貫性", rubric: "人格・口調・知識範囲が一貫し、突然別人格化していないか。" },
  {
    key: "naturalness_score",
    label: "自然さ",
    rubric: "返答が日常会話のテンポで、過剰に説明的・詩的・接客的になっていないか。",
  },
  {
    key: "latency_score",
    label: "応答速度",
    rubric: "実測平均応答時間が目標内に収まり、会話の間として許容できるか。",
  },
  {
    key: "style_score",
    label: "手本との作風一致",
    rubric: "各話者の手本ログに近い短文さ、距離感、語尾、具体性を保てているか。",
  },
  {
    key: "turn_taking_score",
    label: "ターンテイキング",
    rubric:
      "割り込みを避け、相手の発話を受けてから話し始めるか。沈黙や応答速度を自然な間として扱えるか。" +
      "テキストで観測できる範囲の相づち・語尾・視線描写が話者交替に機能しているか。",
  },
  {
    key: "engagement_score",
    label: "相互作用",
    rubric: "一方的に語らず相手の発話へ反応しているか。相づち、共感、短い問い返しの量が適切で、距離感を調整できているか。",
  },
  {
    key: "grounding_score",
    label: "共通基盤",
    rubric: "直前までの話題・指示対象・省略語を保ち、誤解があれば確認や修正を行い、話を飛ばしていないか。",
  },
  {
    key: "metacognition_score",
    label: "メタ認知",
    rubric:
      "自分が何者で、今何ができる/できないかを正しく把握しているか。知らないことや未確認のことを断定せず、" +
      "テキスト会話で物理的な動作を実演したかのように偽っていないか。",
  },
  {
    key: "closure_score",
    label: "会話の収束",
    rubric: "用件や話題が一段落した時に、新しいフックやお願いを足して無用に延命せず、短い受けで静かに閉じられるか。",
  },
];

const LATENCY_TARGET_SECONDS = 8.0;

// -----------------------------------------------------------------------------
// Record model
// -----------------------------------------------------------------------------

export interface EvaluationRecord {
  id: string;
  sessionId: string;
  /** epoch millis */
  evaluatedAt: number;
  /** axis key -> 1..5（パース失敗時は 0） */
  scores: Record<string, number>;
  notes: string;
  /** transcript 中の latencyMs 平均（秒）。計測値が1つもなければ null */
  averageLatencySeconds: number | null;
}

// -----------------------------------------------------------------------------
// Persistence (localStorage, defensive parsing — same pattern as
// conversation.ts / characterStorage.ts)
// -----------------------------------------------------------------------------

const EVALUATIONS_KEY = "tc-town:evaluations";
const MAX_HISTORY_PER_SESSION = 20;

function newEvalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `eval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isEvaluationRecord(value: unknown): value is EvaluationRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.sessionId !== "string" ||
    typeof r.evaluatedAt !== "number" ||
    typeof r.notes !== "string" ||
    !r.scores ||
    typeof r.scores !== "object"
  ) {
    return false;
  }
  return r.averageLatencySeconds === null || typeof r.averageLatencySeconds === "number";
}

function coerceEvaluationRecord(value: unknown): EvaluationRecord | null {
  if (!isEvaluationRecord(value)) return null;
  const scores: Record<string, number> = {};
  for (const [key, v] of Object.entries(value.scores)) {
    if (typeof v === "number") scores[key] = v;
  }
  return {
    id: value.id,
    sessionId: value.sessionId,
    evaluatedAt: value.evaluatedAt,
    scores,
    notes: value.notes,
    averageLatencySeconds: value.averageLatencySeconds,
  };
}

function loadAllEvaluations(): Record<string, EvaluationRecord[]> {
  try {
    const raw = localStorage.getItem(EVALUATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, EvaluationRecord[]> = {};
    for (const [sessionId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const records = list.map(coerceEvaluationRecord).filter((r): r is EvaluationRecord => r !== null);
      if (records.length > 0) out[sessionId] = records;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAllEvaluations(all: Record<string, EvaluationRecord[]>): void {
  try {
    localStorage.setItem(EVALUATIONS_KEY, JSON.stringify(all));
  } catch {
    // Storage full / unavailable — non-fatal.
  }
}

function saveEvaluation(record: EvaluationRecord): void {
  const all = loadAllEvaluations();
  const existing = all[record.sessionId] ?? [];
  const next = [record, ...existing]
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt)
    .slice(0, MAX_HISTORY_PER_SESSION);
  all[record.sessionId] = next;
  persistAllEvaluations(all);
}

/** セッションの評価履歴を新しい順に返す */
export function listEvaluations(sessionId: string): EvaluationRecord[] {
  const all = loadAllEvaluations();
  return [...(all[sessionId] ?? [])].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
}

export function deleteEvaluationsForSession(sessionId: string): void {
  const all = loadAllEvaluations();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  persistAllEvaluations(all);
}

// -----------------------------------------------------------------------------
// Prompt building
// -----------------------------------------------------------------------------

// Speaker-name resolution mirrors conversation.ts's displayName: "user" ->
// "ユーザー", otherwise the character sheet's name, falling back to "不明".
function displayName(speakerId: string, characters: Map<string, Character>): string {
  if (speakerId === USER_SPEAKER_ID) return "ユーザー";
  return characters.get(speakerId)?.sheet.name ?? "不明";
}

function averageLatencySeconds(session: ConversationSession): number | null {
  const values = session.transcript
    .map((entry) => entry.latencyMs)
    .filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;
  const avgMs = values.reduce((sum, v) => sum + v, 0) / values.length;
  return avgMs / 1000;
}

// tc-town has no per-character reference transcript dataset (unlike
// evaluation.py's load_style_reference), so the style exemplar is adapted to
// each participant's own speechStyle sheet field instead.
function formatReferenceBlock(participants: Character[]): string {
  const sections = participants
    .map((c) => ({ name: c.sheet.name.trim() || "不明", style: c.sheet.speechStyle.trim() }))
    .filter((c) => c.style.length > 0)
    .map((c) => `【${c.name} の口調設定】\n${c.style}`);
  if (sections.length === 0) return "";
  return (
    "\n\n手本ログ（口調・テンポ・距離感・短文さ・進行の参考。" +
    "登場人物や話題が違っても、評価対象が自分の役割に合わせて自然に振る舞えていれば加点する）:\n" +
    sections.join("\n\n")
  );
}

// -----------------------------------------------------------------------------
// LLM response parsing (evaluation.py's _extract_json / _coerce_score / _latency_score)
// -----------------------------------------------------------------------------

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

function coerceScore(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) throw new TypeError("evaluation score is not a number");
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

function latencyScoreFallback(avgSeconds: number | null, target: number): number {
  if (avgSeconds === null) return 0;
  return avgSeconds <= target ? 5 : avgSeconds <= target * 2 ? 3 : 1;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * セッションの transcript を LLM judge に採点させる。デフォルト LLM プロファイル
 * (DEFAULT_LLM_PROFILE_ID) を使う。成功時は保存してから resolve。
 * LLM 呼び出し自体の失敗はユーザー向け日本語メッセージの Error を throw。
 */
export async function evaluateSession(
  session: ConversationSession,
  characters: Map<string, Character>,
): Promise<EvaluationRecord> {
  const participants = session.participantIds
    .map((id) => characters.get(id))
    .filter((c): c is Character => c !== undefined);

  const transcriptText = session.transcript
    .map((entry) => `${displayName(entry.speakerId, characters)}: ${entry.text}`)
    .join("\n");

  const rubricBlock = CONVERSATION_AXES.map((axis) => `- ${axis.key} (${axis.label}): ${axis.rubric}`).join("\n");
  const keyList = [...CONVERSATION_AXES.map((axis) => axis.key), "notes"].join(", ");

  const systemContent =
    `${EVALUATOR_ROLE} 各項目を1-5で評価し、JSONだけを返してください。` +
    `キーは ${keyList} です。\n` +
    `各軸は次のルーブリックに厳密に従って採点する:\n${rubricBlock}\n` +
    `notes には減点理由と良かった点を、短く具体的に書いてください。`;

  const avgSeconds = averageLatencySeconds(session);
  const avgLine = avgSeconds === null ? "計測なし" : `${avgSeconds.toFixed(2)} 秒`;
  const referenceBlock = formatReferenceBlock(participants);

  const userContent =
    `応答速度目標: 平均 ${LATENCY_TARGET_SECONDS.toFixed(1)} 秒以内\n` +
    `実測平均: ${avgLine}\n` +
    `${referenceBlock}\n\n${TARGET_LABEL}:\n${transcriptText}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  let responseText: string;
  try {
    responseText = await requestChatCompletion(DEFAULT_LLM_PROFILE_ID, messages, { temperature: 0.2 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`会話の評価に失敗しました: ${detail}`);
  }

  let scores: Record<string, number>;
  let notes: string;
  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    scores = {};
    for (const axis of CONVERSATION_AXES) {
      scores[axis.key] = coerceScore(data[axis.key] ?? 0);
    }
    notes = data.notes === undefined ? "" : String(data.notes);
  } catch {
    scores = {};
    for (const axis of CONVERSATION_AXES) {
      scores[axis.key] = axis.key === "latency_score" ? latencyScoreFallback(avgSeconds, LATENCY_TARGET_SECONDS) : 0;
    }
    notes = `Evaluator returned non-JSON: ${responseText.slice(0, 300)}`;
  }

  const record: EvaluationRecord = {
    id: newEvalId(),
    sessionId: session.id,
    evaluatedAt: Date.now(),
    scores,
    notes,
    averageLatencySeconds: avgSeconds,
  };
  saveEvaluation(record);
  return record;
}

// Character-sheet completeness evaluation — LLM-as-judge scoring for "how
// finished does this character feel", shown in CharactersView.
//
// This is deliberately a separate concern from lib/evaluation.ts, which
// scores a *conversation session* transcript. Here we score the *character
// sheet* itself (draft content, not necessarily saved yet): how clear the
// identity is, how deep the backstory is, how concrete the speech style is,
// how distinctive the character feels, how fleshed-out the relationships
// are, and how well it ties into an optional world setting. The coding
// style (extractJson/coerceScore defensive parsing, localStorage history,
// requestChatCompletion call shape) intentionally mirrors evaluation.ts.

import { DEFAULT_LLM_PROFILE_ID, type Character, type CharacterSheet, type ChatMessage } from "../types";
import { requestChatCompletion } from "./llm";
import { getWorld, type WorldSetting } from "./worlds";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

export interface CharacterEvaluationAxis {
  key: string;
  label: string;
  rubric: string;
}

const EVALUATOR_ROLE = "あなたはキャラクター設定シートの評価者です。";
const TARGET_LABEL = "評価対象のキャラクターシート";

/** 完成度を測る6軸。1-5点で LLM judge が採点する。 */
export const CHARACTER_AXES: readonly CharacterEvaluationAxis[] = [
  {
    key: "identity_score",
    label: "人物像の明確さ",
    rubric: "名前・ひとこと説明・性格が具体的で、読めば人物像がはっきり思い浮かぶか。",
  },
  {
    key: "backstory_score",
    label: "背景の深さ",
    rubric: "生い立ち、価値観、経験など人物・背景の記述に厚みがあり、単なる属性の羅列になっていないか。",
  },
  {
    key: "speech_style_score",
    label: "口調の具体性",
    rubric: "一人称、語尾、口癖、丁寧さなど話し方が具体的に指定され、実際の発話が再現できそうか。",
  },
  {
    key: "distinctiveness_score",
    label: "個性・独自性",
    rubric: "ありがちなテンプレート的キャラではなく、このキャラクター固有の特徴・矛盾・こだわりが感じられるか。",
  },
  {
    key: "relationships_score",
    label: "人間関係",
    rubric: "他者との関係性が具体的に設定され、キャラクターに社会的な文脈・立ち位置があるか。",
  },
  {
    key: "world_fit_score",
    label: "世界観との結びつき",
    rubric:
      "世界観設定と矛盾せず、その世界の中で自然に存在できているか。" +
      "世界観が設定されていない場合は判断材料がないため、中立の3点として採点する。",
  },
];

// -----------------------------------------------------------------------------
// Record model
// -----------------------------------------------------------------------------

export interface CharacterEvaluationRecord {
  id: string;
  characterId: string;
  /** epoch millis */
  evaluatedAt: number;
  /** axis key -> 1..5（パース失敗時は 0） */
  scores: Record<string, number>;
  /** シート各フィールドの充実度から算出したヒューリスティックな記入率 (0-100) */
  fillRate: number;
  /** 総合完成度スコア (0-100)。算出式は computeOverallScore() を参照。 */
  overallScore: number;
  notes: string;
  /** 足りない要素の改善提案。短い箇条書き。 */
  suggestions: string[];
}

// -----------------------------------------------------------------------------
// Persistence (localStorage, defensive parsing — same pattern as evaluation.ts)
// -----------------------------------------------------------------------------

const EVALUATIONS_KEY = "tc-town:character-evaluations";
const MAX_HISTORY_PER_CHARACTER = 10;

function newEvalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `char-eval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function isCharacterEvaluationRecord(value: unknown): value is CharacterEvaluationRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.characterId === "string" &&
    typeof r.evaluatedAt === "number" &&
    typeof r.notes === "string" &&
    typeof r.fillRate === "number" &&
    typeof r.overallScore === "number" &&
    !!r.scores &&
    typeof r.scores === "object" &&
    Array.isArray(r.suggestions)
  );
}

function coerceCharacterEvaluationRecord(value: unknown): CharacterEvaluationRecord | null {
  if (!isCharacterEvaluationRecord(value)) return null;
  const scores: Record<string, number> = {};
  for (const [key, v] of Object.entries(value.scores)) {
    if (typeof v === "number") scores[key] = v;
  }
  const suggestions = value.suggestions.filter((s): s is string => typeof s === "string");
  return {
    id: value.id,
    characterId: value.characterId,
    evaluatedAt: value.evaluatedAt,
    scores,
    fillRate: value.fillRate,
    overallScore: value.overallScore,
    notes: value.notes,
    suggestions,
  };
}

function loadAllEvaluations(): Record<string, CharacterEvaluationRecord[]> {
  try {
    const raw = localStorage.getItem(EVALUATIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, CharacterEvaluationRecord[]> = {};
    for (const [characterId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const records = list
        .map(coerceCharacterEvaluationRecord)
        .filter((r): r is CharacterEvaluationRecord => r !== null);
      if (records.length > 0) out[characterId] = records;
    }
    return out;
  } catch {
    return {};
  }
}

function persistAllEvaluations(all: Record<string, CharacterEvaluationRecord[]>): void {
  try {
    localStorage.setItem(EVALUATIONS_KEY, JSON.stringify(all));
  } catch {
    // Storage full / unavailable — non-fatal.
  }
}

function saveEvaluation(record: CharacterEvaluationRecord): void {
  const all = loadAllEvaluations();
  const existing = all[record.characterId] ?? [];
  const next = [record, ...existing]
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt)
    .slice(0, MAX_HISTORY_PER_CHARACTER);
  all[record.characterId] = next;
  persistAllEvaluations(all);
}

/** キャラクターの評価履歴を新しい順に返す */
export function listCharacterEvaluations(characterId: string): CharacterEvaluationRecord[] {
  const all = loadAllEvaluations();
  return [...(all[characterId] ?? [])].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
}

/** 最新の評価（なければ null） */
export function getLatestCharacterEvaluation(characterId: string): CharacterEvaluationRecord | null {
  return listCharacterEvaluations(characterId)[0] ?? null;
}

export function deleteCharacterEvaluations(characterId: string): void {
  const all = loadAllEvaluations();
  if (!(characterId in all)) return;
  delete all[characterId];
  persistAllEvaluations(all);
}

// -----------------------------------------------------------------------------
// Fill-rate heuristic (no LLM call — pure text-length scoring on the sheet)
// -----------------------------------------------------------------------------

// Each field contributes a 0..1 "fullness" score (length/threshold, capped at
// 1) weighted by how much that field matters to a finished character; the
// weighted average becomes the 0-100 fill rate. summary/persona/speechStyle
// carry the most weight since they drive roleplay quality most directly.
const FILL_FIELDS: { key: Exclude<keyof CharacterSheet, "name">; weight: number; threshold: number }[] = [
  { key: "summary", weight: 1, threshold: 20 },
  { key: "persona", weight: 2, threshold: 120 },
  { key: "speechStyle", weight: 1.5, threshold: 40 },
  { key: "likes", weight: 1, threshold: 30 },
  { key: "relationships", weight: 1, threshold: 30 },
  { key: "notes", weight: 0.5, threshold: 30 },
];

/** シートの各フィールドの充実度から 0-100 の記入率を算出する（LLM 不要）。 */
export function computeFillRate(sheet: CharacterSheet): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const field of FILL_FIELDS) {
    const length = sheet[field.key].trim().length;
    const fullness = Math.min(1, length / field.threshold);
    weightedSum += fullness * field.weight;
    totalWeight += field.weight;
  }
  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 100);
}

// -----------------------------------------------------------------------------
// Overall score
// -----------------------------------------------------------------------------

// Overall completeness (0-100) blends the LLM judge's qualitative read of the
// sheet with the mechanical fill rate: axis average (1-5) is rescaled to
// 0-100 and combined 60/40 with the fill rate, so a sheet that "reads great"
// but is very sparse (or vice versa) doesn't get an inflated score either way.
const LLM_WEIGHT = 0.6;
const FILL_WEIGHT = 0.4;

export function computeOverallScore(axisScores: Record<string, number>, fillRate: number): number {
  const values = CHARACTER_AXES.map((axis) => axisScores[axis.key] ?? 0);
  const axisAverage = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const llmComponent = (axisAverage / 5) * 100;
  return Math.round(llmComponent * LLM_WEIGHT + fillRate * FILL_WEIGHT);
}

// -----------------------------------------------------------------------------
// Prompt building
// -----------------------------------------------------------------------------

function formatSheetBlock(sheet: CharacterSheet): string {
  const lines = [
    `名前: ${sheet.name.trim() || "（未設定）"}`,
    `ひとこと説明: ${sheet.summary.trim() || "（未設定）"}`,
    `人物・背景: ${sheet.persona.trim() || "（未設定）"}`,
    `話し方・口調: ${sheet.speechStyle.trim() || "（未設定）"}`,
    `好き・嫌い: ${sheet.likes.trim() || "（未設定）"}`,
    `人間関係: ${sheet.relationships.trim() || "（未設定）"}`,
    `メモ: ${sheet.notes.trim() || "（未設定）"}`,
  ];
  return lines.join("\n");
}

function formatWorldBlock(world: WorldSetting | undefined): string {
  if (!world || (!world.name.trim() && !world.description.trim())) {
    return "世界観設定: なし（world_fit_score は中立の3点として採点してください）";
  }
  return `世界観設定:\n【${world.name.trim() || "無題の世界"}】\n${world.description.trim()}`;
}

// -----------------------------------------------------------------------------
// LLM response parsing (same defensive style as evaluation.ts)
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

function coerceSuggestions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
      .filter((s) => s.length > 0)
      .slice(0, 6);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((s) => s.replace(/^[-・*\s]+/, "").trim())
      .filter((s) => s.length > 0)
      .slice(0, 6);
  }
  return [];
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * キャラクターシート（渡された character の現在の内容 — 未保存 draft でもよい）
 * の完成度を LLM judge に採点させる。character.llmProfileId を使う。
 * 成功時は保存してから resolve。LLM 呼び出し自体の失敗はユーザー向け日本語
 * メッセージの Error を throw する。
 */
export async function evaluateCharacterSheet(character: Character): Promise<CharacterEvaluationRecord> {
  const sheet = character.sheet;
  const world = getWorld(character.worldId);
  const fillRate = computeFillRate(sheet);

  const rubricBlock = CHARACTER_AXES.map((axis) => `- ${axis.key} (${axis.label}): ${axis.rubric}`).join("\n");
  const keyList = [...CHARACTER_AXES.map((axis) => axis.key), "notes", "suggestions"].join(", ");

  const systemContent =
    `${EVALUATOR_ROLE} 各項目を1-5で評価し、JSONだけを返してください。` +
    `キーは ${keyList} です。\n` +
    `各軸は次のルーブリックに厳密に従って採点する:\n${rubricBlock}\n` +
    `notes には評価の総評を短く具体的に書いてください。` +
    `suggestions には、キャラクターとしての完成度を上げるために足りない要素を、` +
    `箇条書きの短い文字列の配列として2〜5個返してください。`;

  const userContent = `${formatWorldBlock(world)}\n\n${TARGET_LABEL}:\n${formatSheetBlock(sheet)}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const profileId = character.llmProfileId || DEFAULT_LLM_PROFILE_ID;

  let responseText: string;
  try {
    responseText = await requestChatCompletion(profileId, messages, { temperature: 0.2 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`キャラクター評価に失敗しました: ${detail}`);
  }

  let scores: Record<string, number>;
  let notes: string;
  let suggestions: string[];
  try {
    const data = JSON.parse(extractJson(responseText)) as Record<string, unknown>;
    scores = {};
    for (const axis of CHARACTER_AXES) {
      scores[axis.key] = coerceScore(data[axis.key] ?? 0);
    }
    notes = data.notes === undefined ? "" : String(data.notes);
    suggestions = coerceSuggestions(data.suggestions);
  } catch {
    scores = {};
    for (const axis of CHARACTER_AXES) {
      scores[axis.key] = 0;
    }
    notes = `評価器が JSON 以外を返しました: ${responseText.slice(0, 300)}`;
    suggestions = [];
  }

  const record: CharacterEvaluationRecord = {
    id: newEvalId(),
    characterId: character.id,
    evaluatedAt: Date.now(),
    scores,
    fillRate,
    overallScore: computeOverallScore(scores, fillRate),
    notes,
    suggestions,
  };
  saveEvaluation(record);
  return record;
}

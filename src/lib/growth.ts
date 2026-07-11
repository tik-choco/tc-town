// LLM-interview character growth — owned by the "Character data model +
// LLM-interview character growth" workstream.
//
// Two entry points share one JSON-patch protocol:
//   1. sendInterviewMessage()  — an interactive interview where the model
//      plays a curious interviewer, converses in Japanese, and emits sheet
//      patches as it learns.
//   2. growFromConversation()  — a one-shot "what did we learn?" pass over
//      recent chat messages (called by the conversation workstream later).
//
// PATCH PROTOCOL
// The model is instructed to embed, when (and only when) it has learned
// something new about the character, a fenced code block:
//
//   ```json
//   {"summary": "...", "speechStyle": "...", "notes": "..."}
//   ```
//
// The object may contain any subset of the sheet's editable string fields
// (summary, persona, speechStyle, likes, relationships, notes). Each value is
// the FULL updated text for that field (replace semantics), so the model is
// told to restate prior content it wants to keep. Patch blocks are parsed out
// and stripped from the text shown to the user.

import type { Character, CharacterSheet, ChatMessage } from "../types";
import { requestChatCompletion } from "./llm";
import { saveCharacter } from "./characterStorage";
import { getWorld, type WorldSetting } from "./worlds";

/** Editable sheet fields the growth flow may patch (everything except `name`). */
export type SheetPatch = Partial<
  Pick<CharacterSheet, "summary" | "persona" | "speechStyle" | "likes" | "relationships" | "notes">
>;

const PATCH_KEYS: (keyof SheetPatch)[] = [
  "summary",
  "persona",
  "speechStyle",
  "likes",
  "relationships",
  "notes",
];

// --- Patch parsing / merging ------------------------------------------------

/** Matches fenced code blocks, capturing the inner body (language tag optional). */
const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
/** An unterminated trailing fence still being streamed — hidden from display. */
const OPEN_FENCE_RE = /```(?:json)?[\s\S]*$/i;
/** Matches the interview's fenced quick-reply choices block (see {@link parseInterviewChoices}). */
const CHOICES_FENCE_RE = /```choices\s*\n?([\s\S]*?)```/gi;
/** An unterminated trailing choices fence still being streamed — always hidden from display. */
const OPEN_CHOICES_FENCE_RE = /```choices[\s\S]*$/i;

function extractPatchFromObject(value: unknown): SheetPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const patch: SheetPatch = {};
  let found = false;
  for (const key of PATCH_KEYS) {
    const raw = obj[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      patch[key] = raw;
      found = true;
    }
  }
  return found ? patch : null;
}

/**
 * Parses every fenced JSON patch block out of `text` and returns the merged
 * patch (later blocks win per field) plus the text with all complete blocks —
 * and any incomplete trailing block — removed, for display.
 */
export function parseSheetPatch(text: string): { patch: SheetPatch | null; cleaned: string } {
  let merged: SheetPatch | null = null;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      const patch = extractPatchFromObject(parsed);
      if (patch) merged = merged ? Object.assign({}, merged, patch) : patch;
    } catch {
      // Not a JSON patch block — leave it in the displayed text.
    }
  }
  const cleaned = stripPatchBlocks(text);
  return { patch: merged, cleaned };
}

/**
 * Removes JSON patch blocks from `text` for display. Handles both complete
 * fenced blocks and a partial trailing fence (so the raw JSON never flashes
 * mid-stream). Non-JSON fenced blocks are preserved.
 */
export function stripPatchBlocks(text: string): string {
  let out = text.replace(FENCE_RE, (whole, body: string) => {
    try {
      const parsed: unknown = JSON.parse(String(body).trim());
      return extractPatchFromObject(parsed) ? "" : whole;
    } catch {
      return whole;
    }
  });
  // The quick-reply choices block is protocol, never prose — always stripped.
  out = out.replace(CHOICES_FENCE_RE, "");

  // A trailing, not-yet-closed ```json block that looks like it opens a patch.
  const open = out.match(OPEN_FENCE_RE);
  if (open) {
    const after = open[0].replace(/```(?:json)?/i, "").trim();
    // Only strip if it plausibly begins a JSON object (avoid eating prose).
    if (after === "" || after.startsWith("{")) {
      out = out.slice(0, open.index);
    }
  }
  // A trailing, not-yet-closed ```choices block.
  const openChoices = out.match(OPEN_CHOICES_FENCE_RE);
  if (openChoices) out = out.slice(0, openChoices.index);

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parses every fenced ```choices block out of `text` (the interview's
 * quick-reply protocol — a JSON array of short strings) and returns the last
 * non-empty one, or null when the model didn't offer any. Independent of the
 * JSON sheet-patch block above; a single reply may carry both.
 */
export function parseInterviewChoices(text: string): string[] | null {
  let choices: string[] | null = null;
  let match: RegExpExecArray | null;
  CHOICES_FENCE_RE.lastIndex = 0;
  while ((match = CHOICES_FENCE_RE.exec(text)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) {
        const strs = parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "");
        if (strs.length > 0) choices = strs;
      }
    } catch {
      // Not a valid choices block — ignore.
    }
  }
  return choices;
}

/** Applies a patch to a sheet, returning a new sheet (name is never patched). */
export function mergeSheet(sheet: CharacterSheet, patch: SheetPatch): CharacterSheet {
  const next: CharacterSheet = { ...sheet };
  for (const key of PATCH_KEYS) {
    const value = patch[key];
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

/** Keys whose value actually differs between two sheets. */
export function changedSheetKeys(before: CharacterSheet, after: CharacterSheet): (keyof CharacterSheet)[] {
  const keys: (keyof CharacterSheet)[] = ["summary", "persona", "speechStyle", "likes", "relationships", "notes"];
  return keys.filter((k) => before[k] !== after[k]);
}

// --- Prompt construction ----------------------------------------------------

/** Framing block placed alongside the sheet snapshot so the model treats the character as living inside this world setting. Empty when there's no world (or it's blank). */
function worldContextBlock(world: WorldSetting | undefined): string {
  if (!world || (!world.name.trim() && !world.description.trim())) return "";
  return (
    `このキャラクターは次の世界観の中のキャラクターです。\n` +
    `【${world.name.trim() || "無題の世界"}】\n${world.description.trim()}\n\n`
  );
}

function sheetSnapshot(sheet: CharacterSheet): string {
  const lines = [
    `name: ${sheet.name || "(未設定)"}`,
    `summary: ${sheet.summary || "(空)"}`,
    `persona: ${sheet.persona || "(空)"}`,
    `speechStyle: ${sheet.speechStyle || "(空)"}`,
    `likes: ${sheet.likes || "(空)"}`,
    `relationships: ${sheet.relationships || "(空)"}`,
    `notes: ${sheet.notes || "(空)"}`,
  ];
  return lines.join("\n");
}

const PATCH_INSTRUCTIONS =
  "キャラクターについて新しいことが分かったら、その時だけ返答の最後に次の形式のコードブロックを1つ付けてください。\n" +
  "```json\n" +
  '{"summary": "...", "persona": "...", "speechStyle": "...", "likes": "...", "relationships": "...", "notes": "..."}\n' +
  "```\n" +
  "・含めるのは更新したいフィールドだけで構いません（summary / persona / speechStyle / likes / relationships / notes）。\n" +
  "・各フィールドの値は差分ではなく、そのフィールドの更新後の全文を書いてください（残したい既存の内容も含めて書き直す）。\n" +
  "・nameフィールドは絶対に含めないでください。\n" +
  "・まだ何も分かっていない、あるいは更新が不要なときはコードブロックを付けないでください。";

const CHOICES_INSTRUCTIONS =
  "質問を投げかけるときは、ユーザーがワンタップで答えられるよう、可能なら3〜5個程度の短い選択肢を次の形式のコードブロックで添えてください。\n" +
  "```choices\n" +
  '["選択肢1", "選択肢2", "選択肢3"]\n' +
  "```\n" +
  "・選択肢は数語程度の短い言葉にしてください（自由記述も別途できるので「その他」の選択肢は不要です）。\n" +
  "・自由回答でしか答えられないような開かれた質問のときは、このコードブロックを付けなくても構いません。\n" +
  "・これはJSONパッチのコードブロックとは別の、独立したコードブロックとして出力してください。";

function buildInterviewSystemPrompt(sheet: CharacterSheet, world?: WorldSetting): string {
  const name = sheet.name.trim() || "このキャラクター";
  return (
    `あなたは物語のキャラクター設定を深掘りするインタビュアーです。ユーザーと日本語で自然に対話しながら、` +
    `「${name}」という架空のキャラクターの人物像を一緒に作り上げます。\n\n` +
    worldContextBlock(world) +
    "進め方:\n" +
    "・一度に1〜2個の質問に絞り、性格、話し方や口癖、一人称、好き嫌い、他キャラや人との関係、生い立ちや背景などを順に掘り下げてください。\n" +
    "・ユーザーの回答を受け止め、共感や軽い相槌を交えつつ、まだ埋まっていない部分へ話を広げてください。\n" +
    "・ユーザーが「おまかせ」などと言った場合は、あなたが魅力的な設定を提案してもかまいません。世界観と矛盾しない提案にしてください。\n\n" +
    "現在のキャラクターシート（これを踏まえて、まだ薄い部分を優先して質問する）:\n" +
    sheetSnapshot(sheet) +
    "\n\n" +
    PATCH_INSTRUCTIONS +
    "\n\n" +
    CHOICES_INSTRUCTIONS
  );
}

function buildConversationGrowthSystemPrompt(sheet: CharacterSheet, world?: WorldSetting): string {
  const name = sheet.name.trim() || "このキャラクター";
  return (
    `以下は「${name}」というキャラクターと交わした会話の記録です。この会話から、キャラクターの性格・話し方・` +
    `好み・人間関係・背景について新たに読み取れることがあれば、キャラクターシートを更新してください。\n\n` +
    worldContextBlock(world) +
    "現在のキャラクターシート:\n" +
    sheetSnapshot(sheet) +
    "\n\n" +
    "出力はコードブロックのJSONパッチのみで、説明文は不要です。\n" +
    PATCH_INSTRUCTIONS
  );
}

// --- Public flows -----------------------------------------------------------

export interface InterviewResult {
  /** Assistant reply with the JSON patch block stripped, ready to display. */
  reply: string;
  /** Parsed patch, or null when the model emitted none. */
  patch: SheetPatch | null;
  /** The character after merging + saving the patch (unchanged if no patch). */
  character: Character;
  /** Sheet fields that actually changed (for change-highlighting). */
  changed: (keyof CharacterSheet)[];
  /** Quick-reply choices the model offered for its question, or null. */
  choices: string[] | null;
}

const INTERVIEW_KICKOFF = "インタビューを始めてください。まずは最初の質問をどうぞ。";

/**
 * Runs one interview turn. `history` is the prior interview conversation
 * (user/assistant turns, no system message); `userMessage` is the new user
 * answer — pass "" to request the opening question. The character's sheet is
 * patched and saved when the model emits a patch; the updated character is
 * returned. `onDelta` receives the display text (patch blocks stripped).
 */
export async function sendInterviewMessage(
  character: Character,
  history: ChatMessage[],
  userMessage: string,
  options?: { onDelta?: (cleaned: string) => void },
): Promise<InterviewResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildInterviewSystemPrompt(character.sheet, getWorld(character.worldId)) },
    ...history,
    { role: "user", content: userMessage.trim() || INTERVIEW_KICKOFF },
  ];

  const raw = await requestChatCompletion(character.llmProfileId, messages, {
    onDelta: options?.onDelta
      ? (_delta, full) => options.onDelta?.(stripPatchBlocks(full))
      : undefined,
  });

  return { ...applyPatchResult(character, raw), choices: parseInterviewChoices(raw) };
}

/**
 * One-shot growth from a finished/ongoing conversation. `recentMessages` are
 * the recent chat turns (user/assistant). Returns the parsed patch and the
 * saved character (unchanged when nothing was learned).
 */
export async function growFromConversation(
  character: Character,
  recentMessages: ChatMessage[],
): Promise<{ patch: SheetPatch | null; character: Character; changed: (keyof CharacterSheet)[] }> {
  const transcript = recentMessages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "ユーザー" : character.sheet.name || "キャラクター"}: ${m.content}`)
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: buildConversationGrowthSystemPrompt(character.sheet, getWorld(character.worldId)) },
    { role: "user", content: transcript || "(会話なし)" },
  ];

  const raw = await requestChatCompletion(character.llmProfileId, messages);
  const result = applyPatchResult(character, raw);
  return { patch: result.patch, character: result.character, changed: result.changed };
}

function applyPatchResult(character: Character, raw: string): InterviewResult {
  const { patch, cleaned } = parseSheetPatch(raw);
  if (!patch) {
    return { reply: cleaned, patch: null, character, changed: [], choices: null };
  }
  const nextSheet = mergeSheet(character.sheet, patch);
  const changed = changedSheetKeys(character.sheet, nextSheet);
  if (changed.length === 0) {
    return { reply: cleaned, patch, character, changed: [], choices: null };
  }
  const nextCharacter: Character = { ...character, sheet: nextSheet };
  saveCharacter(nextCharacter);
  return { reply: cleaned, patch, character: nextCharacter, changed, choices: null };
}

// --- Auto-fill ("お任せで作成") -----------------------------------------------

const AUTO_FILL_INSTRUCTIONS =
  "出力は次の形式のJSONコードブロック1つだけにしてください。挨拶や説明文は不要です。\n" +
  "```json\n" +
  '{"summary": "...", "persona": "...", "speechStyle": "...", "likes": "...", "relationships": "...", "notes": "..."}\n' +
  "```\n" +
  "・summary / persona / speechStyle / likes / relationships の5項目は必ず具体的な内容で埋めてください（notesは空文字のままで構いません）。\n" +
  "・既に内容が書かれているフィールドも、根幹の設定（人物像の核）を変えずに、より具体的で魅力的な文章に書き直して構いません。素っ気ない内容や短すぎる内容は積極的に膨らませてください。\n" +
  "・各値はそのフィールドの最終的な全文です（差分ではなく書き直してください）。\n" +
  "・nameフィールドは絶対に含めないでください。";

function buildAutoFillSystemPrompt(sheet: CharacterSheet, world?: WorldSetting): string {
  const name = sheet.name.trim() || "このキャラクター";
  const hasExisting = PATCH_KEYS.some((key) => sheet[key].trim() !== "");
  return (
    `あなたはキャラクター設定作家です。「${name}」という架空のキャラクターの魅力的で一貫性のあるキャラクターシートを、` +
    `${hasExisting ? "既に書かれている内容を土台に、薄い部分は書き足し、書かれている部分もより具体的で魅力的な文章に磨き上げて" : "ゼロから"}日本語で作成してください。\n\n` +
    worldContextBlock(world) +
    "現在のキャラクターシート:\n" +
    sheetSnapshot(sheet) +
    "\n\n" +
    AUTO_FILL_INSTRUCTIONS
  );
}

const AUTO_FILL_KICKOFF = "このキャラクターのキャラクターシートをお任せで作成してください。";

export interface AutoFillResult {
  /** Parsed patch, or null when the model emitted none. */
  patch: SheetPatch | null;
  /** The character after merging + saving the patch (unchanged if no patch). */
  character: Character;
  /** Sheet fields that actually changed (for change-highlighting / staged reveal). */
  changed: (keyof CharacterSheet)[];
}

/**
 * One-shot "お任せで作成" full-sheet generation, sharing the JSON-patch
 * protocol with the interview flow (see module doc). Existing non-empty
 * fields are passed as context and actively rewritten to be more vivid
 * (not just left alone / used to fill gaps), while keeping the character's
 * core identity intact.
 */
export async function autoFillCharacterSheet(character: Character): Promise<AutoFillResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildAutoFillSystemPrompt(character.sheet, getWorld(character.worldId)) },
    { role: "user", content: AUTO_FILL_KICKOFF },
  ];
  const raw = await requestChatCompletion(character.llmProfileId, messages);
  const result = applyPatchResult(character, raw);
  return { patch: result.patch, character: result.character, changed: result.changed };
}

// --- Per-field improve --------------------------------------------------------

/** Sheet field a single-field improve request can target. */
export type SheetFieldKey = keyof SheetPatch;

const FIELD_LABELS: Record<SheetFieldKey, string> = {
  summary: "ひとこと説明",
  persona: "人物・背景",
  speechStyle: "話し方・口調",
  likes: "好き・嫌い",
  relationships: "人間関係",
  notes: "メモ",
};

function buildFieldImproveSystemPrompt(sheet: CharacterSheet, field: SheetFieldKey, world?: WorldSetting): string {
  const name = sheet.name.trim() || "このキャラクター";
  const label = FIELD_LABELS[field];
  const hasExisting = sheet[field].trim() !== "";
  return (
    `あなたはキャラクター設定作家です。「${name}」という架空のキャラクターの「${label}」の項目を、` +
    `${hasExisting ? "今書かれている内容の核は変えずに、より具体的で魅力的な文章に磨き上げて" : "他の項目と矛盾しないよう新しく書き起こして"}ください。\n\n` +
    worldContextBlock(world) +
    "キャラクターシート全体（他の項目とは矛盾しないようにする。書き直すのは「" +
    label +
    "」だけ）:\n" +
    sheetSnapshot(sheet) +
    "\n\n" +
    "出力は次の形式のJSONコードブロック1つだけにしてください。説明文は不要です。\n" +
    "```json\n" +
    `{"${field}": "..."}\n` +
    "```\n" +
    `・値は「${label}」フィールドの最終的な全文です（差分ではなく書き直し）。\n` +
    "・他のフィールドは含めないでください。"
  );
}

export interface FieldImproveResult {
  /** Parsed patch, or null when the model emitted none. */
  patch: SheetPatch | null;
  /** The character after merging + saving the patch (unchanged if no patch). */
  character: Character;
  /** Sheet fields that actually changed — always [] or [field]. */
  changed: (keyof CharacterSheet)[];
}

/**
 * One-shot improve pass scoped to a single sheet field, sharing the
 * JSON-patch protocol. Used by the per-field "この項目をより良くする" action
 * so a user can polish one section without regenerating the whole sheet.
 */
export async function improveCharacterSheetField(
  character: Character,
  field: SheetFieldKey,
): Promise<FieldImproveResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildFieldImproveSystemPrompt(character.sheet, field, getWorld(character.worldId)) },
    { role: "user", content: `「${FIELD_LABELS[field]}」をより良くしてください。` },
  ];
  const raw = await requestChatCompletion(character.llmProfileId, messages);
  const result = applyPatchResult(character, raw);
  return { patch: result.patch, character: result.character, changed: result.changed };
}

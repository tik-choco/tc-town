# TC Town

VRM対応のキャラクター会話アプリ。自分だけのキャラクターを作り、育て、会話や通話を楽しめる Preact + TypeScript + Vite 製の Web アプリです。

## 主な機能

- **キャラクター作成・管理** — 名前、人物像、話し方、好み、人間関係などの性格シートを編集。アバターは画像または VRM モデルに対応。
- **LLMインタビューによる性格シート育成** — インタビュアーAIとの対話や既存の会話から、キャラクターの性格シートを自動で追記・更新します。
- **複数キャラ同士の自動会話** — 複数のキャラクターを1つの会話に参加させ、それぞれ自分のペルソナで自動的に会話させられます。ユーザーも途中で発言可能。
- **音声通話** — TTS/STT を使って、キャラクターと音声で会話。
- **AI Network（mistlib）対応** — ルームを共有して、他の端末の LLM を利用（コンシューマー）したり、自分の LLM を提供（プロバイダー）したりできます。
- **OpenAI互換の LLM / TTS / STT 設定** — 任意の OpenAI 互換エンドポイントを複数プロファイルとして登録できます。

すべてのデータ（キャラクター、会話、設定）はブラウザの localStorage / IndexedDB に保存され、サーバーには送信されません。

## 開発

依存関係をインストールしたうえで、以下のコマンドを使います。

```bash
npm run dev      # 開発サーバー（http://localhost:5173/ 付近）
npm run build    # 型チェック（tsc -b）＋本番ビルド
npm run preview  # ビルド結果のプレビュー
npm test         # テスト（vitest）
```

### mistlib（AI Network）の取得

`npm run dev` / `npm run build` の前段（predev / prebuild）で `scripts/fetch-mistlib.mjs` が実行され、mistlib のソースを取得して wasm をベンダリングします。取得先は `.env` で指定します。

```bash
cp .env.example .env
```

| 変数 | 説明 | 既定 |
| --- | --- | --- |
| `MISTLIB_REPO` | mistlib のリポジトリ（`git@github.com:<org>/<repo>.git`） | （必須） |
| `MISTLIB_REF` | 取得するブランチ／タグ／コミット | `develop` |

## ディレクトリ構成

```
src/
  app.tsx              シェル（ヘッダー + キャラクター/会話/通話/設定 のナビ）
  main.tsx             エントリーポイント（テーマ適用 + レンダリング）
  types.ts             横断的なドメイン型（Character / CharacterSheet / ChatMessage など）

  views/
    CharactersView.tsx キャラクター一覧・編集・成長インタビュー
    ChatView.tsx       複数キャラ会話・自動会話・「会話から学習」
    VoiceView.tsx      音声通話
    SettingsView.tsx   LLMプロファイル / AI Network / TTS・STT / 表示設定

  lib/
    characterStorage.ts キャラクターCRUD・購読・toPersonaPrompt（正規のペルソナ生成）
    growth.ts           LLMインタビュー・会話からのシート育成（JSONパッチ方式）
    conversation.ts     会話オーケストレーション（ConversationEngine・セッション・自動会話）
    voice.ts            録音 / TTS / STT
    llm.ts              OpenAI互換チャット補完（ストリーミング）
    llmSettings.ts      プロバイダー設定の永続化
    network.ts          AI Network（@tik-choco/mistai）連携
    appSettings.ts      アプリ設定（テーマ・言語）
    idbBlobStore.ts     アバター画像などのバイナリ保存（IndexedDB）
    sharedBus.ts        タブ間・モジュール間の通知

  components/
    CharacterAvatar.tsx 画像 / VRM アバター表示
    AvatarPicker.tsx    アバターの選択・アップロード

  vrm/                  VRM の読み込み・アニメーション・ステージ描画（tc-vrm-viewer互換）
  hooks/                useAppSettings ほか
  styles/               ビューごとの CSS（shell / characters / chat / voice / settings / avatar）
  index.css             共有デザイントークン（tik-choco アプリファミリー）
```

## 技術スタック

Preact 10 / TypeScript / Vite 8 / three.js + @pixiv/three-vrm（VRM）/ @tik-choco/mistai（AI Network）/ lucide-preact（アイコン）

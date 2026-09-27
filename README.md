# Canvas Horizon

Canvas LMS のデスクトップクライアントです。各種タスクの提出管理、教材や添付ファイルの閲覧・ダウンロード、関連動画コンテンツの視聴などをデスクトップ上で行えます。

## 開発環境とビルド

Node.js 18 以上が必要です。

```bash
# リポジトリのクローン
git clone https://github.com/shizengakari/CanvasLMS-Horizon.git
cd CanvasLMS-Horizon

# 依存関係のインストール
npm install

# 開発モード起動
npm run dev

# Windows 向けビルド
npm run build
```

ビルド成果物は `build/Canvas Horizon-win32-x64/` に出力されます。

## 設定

アプリ起動後、設定画面で以下を入力します。

1. **Canvas LMS Base URL**: 大学の Canvas ログイン URL（例: `https://<大学名>.instructure.com`）
2. **Canvas API Token**: Canvas LMS の [アカウント] ➔ [設定] ➔ [新しいアクセストークン] から生成したトークン

※ 入力した設定およびトークンは、ローカル PC（`AppData/Roaming/Canvas Horizon`）にのみ保存されます。

## 免責事項

本ソフトウェアは個人による非公式のオープンソースプロジェクトです。Instructure 社および各教育機関とは一切関係ありません。

## ライセンス

MIT License

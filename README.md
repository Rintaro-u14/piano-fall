# Piano Fall

MIDIを読み込むと、ブラウザ内だけで落下ノート、鍵盤、簡易譜面、推定コードを表示するTypeScript製のWebアプリです。MIDIファイルはサーバーへ送信せず、`@tonejs/midi`で解析します。再生はWeb Audio API、動画保存はCanvasのMediaRecorderを使います。

## 開発

```bash
npm install
npm run dev
```

`.env.local`にはClerkのキーと、利用を許可するGoogleアカウントを設定します。

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
ALLOWED_GOOGLE_EMAIL=u14.rin.y@gmail.com
```

ログイン画面はGoogle OAuthだけを表示し、サーバー側でも`ALLOWED_GOOGLE_EMAIL`と一致するメールアドレスだけを通します。

## Vercel

このリポジトリはVercelプロジェクト `piano-fall` に接続されています。Clerk Marketplace連携でキーを管理し、次の環境変数をDevelopment / Preview / Productionに設定します。

- `ALLOWED_GOOGLE_EMAIL`
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-in`
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/`
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/`

ClerkのSocial ConnectionsではGoogleだけを有効にしてください。Production instanceでGoogle OAuthを使う場合は、Clerk Dashboardの指示に従ってGoogle CloudのOAuthクライアント情報を設定します。

```bash
npx vercel --prod
```

## 主な機能

- `.mid` / `.midi` のドラッグ＆ドロップ、ファイル選択、サンプル読み込み
- トラックごとの表示切り替えと色設定
- 表示鍵域、落下時間、背景色、速度、音量、ミュート
- Web Audio APIによる簡易ピアノ音源
- Canvasの30fps録画。ブラウザが対応していればMP4、対応しない場合はWebMで保存
- ローカルストレージへの表示設定保存

## 既存のPython実装について

旧版のPythonローカルスタジオ、解析モジュール、テスト、サンプル生成スクリプトは互換資料としてリポジトリに残しています。公開Webアプリの起動経路はNext.jsの`app/`と`public/`です。

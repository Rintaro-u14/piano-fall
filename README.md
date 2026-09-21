# Piano Fall — ローカルMIDI動画スタジオ

MIDIを読み込むと、落下ノートとピアノ鍵盤を表示し、SoundFont音声付きの **1920×1080 / 30・60fps MP4** を生成するMVPです。Python + ブラウザUI。MIDI解析・音声合成・動画生成はこのPC内で完結し、アカウント・クラウド・GPUは不要です。配布サイトの検索・URL取り込みにはインターネットを使います。

## このPCですぐ使う

このフォルダーには **Windows用の専用仮想環境をセットアップ済み** です。`start.bat` をダブルクリックすると、ブラウザで <http://127.0.0.1:8765> が開きます。ターミナルは開いたままにしてください。終了はターミナルで `Ctrl+C`。

以前の作業にあった `GeneralUser-GS.sf2` は、このPC用に `data/soundfonts/` へコピーしてあります。そのまま音声付きで試せます。ソース配布ZIPには環境・SoundFont・キャッシュを含めていません。

1. 「サンプルを試す」、またはMIDIのドラッグ＆ドロップ / ファイル選択。
2. 初回は「音声プレビューを準備」。パート別SoundFontステムを準備後、Web Audioで再生します。再生ボタンからも自動準備できます。
3. 色・表示鍵域・落下速度・鍵盤高さ・トラックを調整。
4. 30 fps / 60 fpsを選び、「MP4を書き出す」。
5. 完了後の「完成したMP4を保存」を押す。元の完成ファイルは `data/exports/` にも残ります。

起動済みの同じアプリがある場合は、新しく起動せずブラウザのURLを開いてください。

## アプリを更新したとき

ファイルの更新後は、起動用ターミナルで `Ctrl+C` を押してサーバーを終了し、`start.bat` で起動し直してください。その後ブラウザを `Ctrl+F5` で更新します。画面の更新だけでは、実行中のPythonサーバーは新版になりません。

「古いサーバーが動いています」と出た場合も同じ手順です。APIの互換性を起動時に確認し、未対応の楽譜APIを呼ばないようにしています。

## 別のWindows PCへセットアップ

- Windows 10/11、64bit Python **3.10 / 3.11 / 3.12**。推奨は3.12。
- Edge / Chrome等の現行ブラウザ。
- 初回セットアップにはインターネット接続が必要。セットアップ後のローカルファイル読み込み・楽譜・音声・動画生成はオフラインで使用できます。検索・URL取り込みのみオンラインです。

1. ZIPを任意の書き込み可能なフォルダーへ展開。
2. [python.org](https://www.python.org/downloads/windows/) からPythonをインストール（Python Launcherも有効にする）。
3. `setup.bat` をダブルクリック。専用の `.venv` が作成され、依存ライブラリとFFmpegバイナリが入ります。
4. `start.bat` をダブルクリック。
5. 音源の「.sf2ファイルを選ぶ」でGeneral MIDI対応SoundFontを指定。

再生・動画書き出しの全体音量はスタジオ設定から0〜200%で調整でき、初期値は100%です。100%は旧版の160%と同じ実効音量で、設定はブラウザに保存されます。

SoundFont本体はZIPに同梱していませんが、`setup.bat` / `start.bat` は未導入時に既定音源としてGeneralUser GSを公式GitHubから自動取得します。取得できない場合は従来どおり「.sf2ファイルを選ぶ」から手動指定できます。検証には [GeneralUser GS / S. Christian Collins](https://github.com/mrbumpy409/GeneralUser-GS) を使用しました。音源の利用条件は配布元で確認してください。`soundfonts/` または `data/soundfonts/` に `.sf2` を置く方法、起動時に環境変数 `PIANOFALL_SF2` を指定する方法もあります。選択したSF2はローカルサーバーへコピーされ、外部には送信されません。

### 手動セットアップ / Linux

```bash
python -m venv .venv
# Windows:
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m pip install --no-deps tinysoundfont==0.3.7
.venv\Scripts\python app.py

# Linux: Python 3.10〜3.12を使用
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip install --no-deps tinysoundfont==0.3.7
.venv/bin/python app.py --no-browser
```

`tinysoundfont` は意図的に `--no-deps` でインストールします。本アプリはオフライン合成機能を使い、音声デバイスを操作するPyAudioには依存しません。FluidSynth、PortAudio、Node.jsの別途インストールは不要です。FFmpegは `imageio-ffmpeg` のプラットフォーム用バイナリを使います。別のFFmpegを使う場合は `IMAGEIO_FFMPEG_EXE` に実行ファイルのフルパスを設定できます。

## ピアノだけを映して伴奏を残す

`Four_Piece_Game_Medley.mid` / `Live_Medley_v2.mid` を読み込み、Guitar・Bass・Drumsの **「表示」だけ** をオフにします。Pianoの「表示」はオン、全トラックの「音声」はオンのまま再生・MP4書き出しを行ってください。逆に表示オン・音声オフも可能です。

JSONでは `hiddenTracks` が映像のみ、`mutedTracks` が音声のみを制御します。旧バージョンの `hiddenTracks` は両方をオフにしていましたが、今回から映像だけに作用します。旧設定で両方をオフにしたい場合は、同じ番号を `mutedTracks` にも指定してください。

## MIDIを探して取り込む

上部の「MIDIを探す」を開き、曲名・アーティスト名を入力して「MIDIを検索」。**BitMidi / MIDI World / MidisFree / MIDI DB / Midi uploader.jp (`by_cif`) を横断検索し、配布元ごとに分けず1つの候補一覧にまとめます。** 候補の「このMIDIを使う」を押すと、対応サイトではMIDIの取得・解析・プレビューまで直接進みます。

- **BitMidi**：検索結果の曲ページから `.mid` を解決します。
- **MIDI World**：検索エンドポイントを試し、利用できない場合はアルファベット別の作者一覧から作者ページをたどって直接ダウンロードURLを取得します。
- **MidisFree**：WordPressの検索結果から曲ページを取得し、ページ内のDownload / `wpdmdl` URLを解決します。
- **MIDI DB**：検索結果の曲ページから `midi-download/*.mid` を取得します。無料分はサイトの説明どおりデモの場合があります。
- **Midi uploader.jp (`by_cif`)**：公開一覧をMIDIだけ索引化して検索します。索引は6時間キャッシュします。個別ページから公開ダウンロードURLを解決できない場合は、配布ページで保存したファイルを読み込んでください。

検索結果は最大40件まで表示します。同名の完全重複はまとめます。1サイトが一時的に停止していても、ほかのサイトの結果は表示します。URLを直接貼り付ける場合も上記5サイトに対応しています。サイトから保存した `.mid` / `.midi` は「保存したMIDIを開く」またはドラッグ＆ドロップでも読み込めます。

取得したデータは先頭が Standard MIDI File の `MThd` であることを検証します。外部URLは許可した配布サイトのHTTPSだけに制限し、リダイレクト先も再検証します。各曲の著作権・配布条件・利用条件は配布ページで確認してください。

2026-09-19時点で確認した主なページ構造：

| サイト | 横断検索での扱い |
|---|---|
| [BitMidi](https://bitmidi.com/) | サイト内検索 → 曲ページ → MIDI |
| [MIDI World](https://www.midiworld.com/files/) | 検索 + 作者インデックスのフォールバック → `/download/<id>`。検索時に直リンクを軽量検証し、404等の死んだ候補を除外 |
| [MidisFree](https://midisfree.com/) | WordPress検索 → `/download/.../` → Download URL |
| [MIDI DB](https://www.mididb.com/) | 検索 → 曲ページ → `/midi-download/*.mid` |
| [Midi uploader.jp / by_cif](https://uu.getuploader.com/by_cif/) | 公開一覧を索引化 → `/by_cif/download/<id>` |

## 楽譜・推定コード

「楽譜・推定コード」で、それぞれ表示 / 非表示を切り替えます。**表示状態はMP4にも反映**します。

- 楽譜のパートはチェックボックスで複数選択できます。選択したパートごとにト音・ヘ音の大譜表を別の段で表示。「すべて選択」「解除」にも対応し、ドラムは対象外です。新しいMIDIではピアノ音色を優先して1パート選択します。音声ミュート・落下ノートの表示とは独立しています。
- 同時表示は **初期値4小節**。「同時に表示する小節数」で **1〜8小節** に変更できます。4小節なら1〜4、5〜8…のページ単位で切り替わり、最終ページは残りの小節だけを表示します。各段の縦線が再生位置を示し、シーク・速度・テンポ・拍子変更にも追従します。設定した小節数はブラウザに保存されます。
- パート数が増えると楽譜の高さを自動調整し、小節数が増えると横幅を詰めます。読みやすさを優先する場合は、同時に選ぶパートや小節数を減らしてください。
- 音価・休符・シャープ / ナチュラル・付点・小節をまたぐタイを簡易表示。C4以上を上段、未満を下段に分け、極端な音域にはオクターブ移記を使います。
- **16分音符単位に丸めた簡易採譜**です。調号・異名同音の最適化、複雑な声部分け・連桁・連符・装飾音・ペダル記号・本格的な印刷用浄書には未対応です。画面と同じ簡易採譜を複数ページPDFとして保存できます。譜面の丸めは元MIDIの音声や落下ノートの時刻を変更しません。
- コードは **MIDIでピアノ系音色（GM 1〜8番）になっているパートだけ** を使い、小節内の音の長さとvelocityを重み付けして **1小節につき1つ** 推定します。左右の手が別のピアノパートでも合わせて解析します。表示は **小節の頭で切り替え、小節内では維持**。長短三和音・7th・maj7・m7・dim・aug・sus2・sus4と転回形に対応。`PIANO CHORD / EST.` として左端に表示します。
- `?` は判定困難、`N.C.` は無音。ピアノ以外の楽器は推定に含めません。楽譜で選択したパート、トラックの表示・ミュート、音色の上書き設定からは独立し、元MIDIの音色情報を使います。ピアノパートがない場合は `?` になります。原曲の正しいコードや演奏可能なピアノ編曲を保証するものではありません。

## 楽器の音色・音量

トラック欄の **CHごとの音色選択と音量スライダー** で設定します。1トラックに複数チャンネルがあるType 0にも対応し、別トラックで同じチャンネルを使う場合も個別に調整できます。

- 音色：GMの128音色。「MIDIの音色」に戻すと元のProgram Changeを反映します。
- CH10のドラム：選択したSoundFontに収録されているドラムキットを列挙します。別のSoundFontに切り替えて指定音色が存在しなくなった場合は、音声生成時にエラーで案内します。
- 音量：0〜200%。100%が元のMIDIの音量、0%でそのパートを消音。MIDI側のVolume / Expression変化に倍率を掛けます。大きく上げると音割れする場合があります。
- **全体音量・パート音量・音声ON/OFFはWeb Audioで再生中も即時反映**します。音色変更だけは対象パートのステムをバックグラウンドで再合成し、準備できた時点で現在位置へ差し替えます。他パートや再生位置は止まりません。MP4には同じ設定を使います。
- 新しいMIDIを開くと音色・音量と譜面パートをリセットします。元MIDIそのものは変更せず、元MIDI保存にも編集設定は焼き込みません。

## 操作と設定

| 項目 | 動作 |
|---|---|
| MIDI入力 | ドロップ / ファイル選択。Standard MIDI Type 0 / Type 1 |
| 再生 | ▶ / 一時停止 / 先頭に戻る / シークバー。フォーカスが入力欄やボタン以外ならSpaceでも操作 |
| 再生速度 | 0.25〜2.0倍。BPM表示と書き出しにも反映。音程は維持 |
| 鍵盤 | 初期状態はA0〜C8の88鍵。発音中の鍵盤をノート色で点灯 |
| 色 | トラック別 / MIDIチャンネル別。トラック右端またはチャンネル欄で色を変更 |
| トラック | 「表示」と「音声」を独立して切り替え。どちらも再生を止めず即反映 |
| 背景 | カラーピッカーで変更 |
| 鍵盤の高さ | 画面の12〜40% |
| 落下の見通し | 1〜10秒先まで表示。短いほど速く落下 |
| 表示鍵域 | 88鍵 / ノートに合わせる / MIDI番号0〜127の任意範囲。鍵域外の音声はミュートされない |
| 音源 | SF2のGM program change、ドラムCH10、volume / pan / sustain、pitch bendを合成 |
| ミュートボタン | プレビューだけを消音。MP4の音声には影響しない |
| MP4 | H.264 / yuv420p、AACステレオ、44.1kHz、1920×1080固定、30/60fps |

映像設定はブラウザに保存されます。MIDIは再度読み込んでください。トラックの表示・音声状態は新しいMIDIを開くとリセットされます。BPMは四分音符基準です。6/8等でも分母に応じて拍線は変化します。

鍵盤の点灯・バーの長さは **Note On〜Note Off**。サステインペダルによる余韻は音声に反映しますが、鍵盤を離した後の余韻までバーは伸ばしません。末尾には2秒の余韻を加えます。

## 安定した動画レンダリング

1. Midoで全トラックのイベントを絶対tick順に並べ、tempo変更を区間ごとに積分して共通の秒時刻へ変換。
2. プレビューはTinySoundFontでパートごとのステムをキャッシュし、ブラウザのWeb Audio APIでリアルタイムにミックス。動画書き出しは従来どおり同じ秒時刻に従ってTinySoundFontで完成WAVを合成。
3. Pillowで各出力フレームの時刻を直接描画し、FFmpegの標準入力へRGBフレームを送る。画面録画、ブラウザのタブ状態、実時間の描画速度に依存しない。
4. 速度変更時は映像時刻をスケールし、音声をFFmpeg `atempo` で処理。完成後に一時ファイルをMP4へ確定。

処理は1ジョブずつ。進捗表示、キャンセル、失敗時のエラー表示に対応します。音声はMIDI・SoundFont・ミュート・パート別音色・音量設定単位でキャッシュし、色の変更で再合成しません。1フレームずつ処理し、全動画フレームをメモリには保持しません。

### コマンドライン書き出し

```powershell
.venv\Scripts\python render_midi.py samples\Aurora_Study.mid --sf2 "C:\SoundFonts\GeneralUser-GS.sf2" --fps 60 --output movie.mp4
```

テンポ変更を含む特定区間だけを1.5倍速で書き出す例（start/endは元MIDIの秒時刻）：

```powershell
.venv\Scripts\python render_midi.py song.mid --sf2 "C:\SoundFonts\GeneralUser-GS.sf2" --start 30 --end 40 --speed 1.5 --fps 60 --output clip.mp4
```

`--settings settings.json` で映像・音声設定を指定できます。

```json
{
  "background": "#10191e",
  "colorMode": "channel",
  "colors": {"channel:0": "#77e4c8", "channel:1": "#ac9bff"},
  "minPitch": 21,
  "maxPitch": 108,
  "keyboardHeight": 0.22,
  "fallSeconds": 3.5,
  "hiddenTracks": [1, 2, 4],
  "mutedTracks": [],
  "showScore": true,
  "showChords": true,
  "scoreParts": ["1:0", "3:2"],
  "scoreMeasures": 4,
  "partPrograms": {"3:2": 0},
  "partVolumes": {"3:2": 0.8}
}
```

トラック・チャンネル番号はJSONでは0始まり、UIのチャンネル番号は1始まりです。パートIDは `トラック番号:チャンネル番号`。`scoreParts` は表示したい音程楽器のID配列、空配列 `[]` で全解除、`scoreMeasures` は1〜8の整数です。上記 `3:2` はトラック4 / CH3の例です。従来の単一指定 `scorePart` もCLI/API向けに互換対応しています。

## 検証

詳細は [VALIDATION.md](VALIDATION.md)。Windows Python 3.10.11とLinux Python 3.10.12で実行しています。

- サンプル：自作の `Aurora_Study.mid`。5トラック（4演奏パート）、73ノート、120→90→150 BPM、4/4→3/4→2/4、ペダル、ドラム、テンポ変更をまたぐ音符。
- 既存のメドレーMIDI3本：最大49トラック、2万〜2.5万ノート、テンポ変更16〜43件。曲長をMidoの全曲再生時間と照合。
- 約16分の既存MIDIの全曲音声合成、テンポ変更区間の60fps・1.5倍速動画生成。
- ブラウザの読み込み・音声再生・一時停止・シーク・速度・BPM/拍子・色・鍵域・トラックミュート・書き出しを確認。
- 1080p30/60のフルサンプルMP4生成、H.264/AACストリーム、音声有無、フレーム数と曲長を確認。
- WindowsネイティブPythonと付属Windows FFmpegでのMP4生成に成功。

```powershell
.venv\Scripts\python -m pip install pytest
$env:PIANOFALL_TEST_SF2 = "C:\SoundFonts\GeneralUser-GS.sf2"
.venv\Scripts\python -m pytest tests -q
```

環境変数なしでは音源を必要とする統合テストをスキップします。MIDI解析、テンポ境界、Note On velocity=0、同音重複、欠けたNote Off、Type 0、拍子、鍵盤点灯、入力検証、音声ミュート、キャンセル、部分ダウンロードを検証します。

## MVPの制限

- Standard MIDI Type 2（非同期トラック）、SMPTE division、MIDI 2.0は対象外。エラーを表示します。
- GM基本音源を対象にします。SysExによるGS/XG設定、aftertouch、すべてのCC・SoundFontモジュレーターの完全再現は対象外。SysExを含むMIDIでは警告を表示します。
- 同じチャンネルはMIDIの仕様に従ってprogram / controller状態を共有します。トラックの音声をオフにしても、そのトラックのチャンネル制御イベントは残します。発音はトラック＋チャンネルごとの仮想音源チャンネルに振り分け、ユーザー指定の音色と音量を個別に適用します。同じパート内の同一音程の重複発音は音源エンジンに依存します。
- 最大20MB / 50万イベント / 1時間のMIDI、最大512MBのSF2。512ボイス上限。長い曲は音声準備と書き出しに時間がかかります。
- 音声プレビューは初回にパート別ステムの準備が必要です。準備後は全体音量・各パート音量・Muteを再合成なしで変更できます。音色変更はそのパートだけ再合成します。SoundFont未選択でも無音の映像プレビューはできますが、音声付きMP4にはSF2が必要です。
- キャッシュ・元MIDI・SoundFont・MP4は `data/` に残り、自動削除しません。アプリを終了して不要なファイルを削除できます。ステレオWAVは約10MB/分が目安です。
- プレビューはCanvas、書き出しはPillowのため、文字のフォントやアンチエイリアスには軽微な違いがあります。ノート時刻・鍵盤座標・色・設定は共通の仕様です。
- 署名付きインストーラー / 単体EXE化、印刷用楽譜出力、ライブMIDI入力、練習判定は今回の範囲外です。

## トラブルシューティング

- **音が出ない**：SF2を選択し、音声準備が完了した後で ▶ を押す。ブラウザが再生を制限する場合は、もう一度 ▶ を押してください。プレビューのミュート・OS音量も確認。
- **ブラウザが開かない**：ターミナルの起動表示を確認し、<http://127.0.0.1:8765> を手動で開く。
- **ポート使用中**：先に起動したアプリを終了するか、`app.py --port 8766` で起動。
- **パッケージが入らない**：Python 3.10〜3.12 / 64bitか確認。`setup.bat` のエラー表示を確認。
- **書き出し失敗**：ディスク空き容量、音源ファイル、ターミナルのエラーを確認。FFmpegエラー時は `data/exports/*.ffmpeg.log` に詳細が残ります。

## 構造

```text
piano-fall/
  app.py                  ローカルAPI、ファイル保存、ジョブ管理
  render_midi.py          コマンドライン書き出し
  pianofall/
    midi.py               テンポ・拍子・トラック・ノート解析
    audio.py              SoundFontから完成WAV / パート別ステムを合成
    render.py             Pillowフレーム描画 + FFmpeg
    settings.py           設定検証、88鍵盤の座標
    library.py            配布サイト検索リンク、URL取り込み
    music.py              小節・コード解析、大譜表の描画
  static/                 HTML / CSS / Canvasプレイヤー / Web Audioミキサー
  samples/                自作MIDIと再生成スクリプト
  tests/                  解析・描画・API・音声のテスト
  setup.bat / start.bat    Windowsセットアップ・起動
  requirements.txt        Python依存
  data/                   ローカル入力・音声キャッシュ・出力（配布ZIP外）
```

本体UI・描画・サンプルは独自実装です。Synthesiaのコード・画像・音源・固有アセットは使用していません。[Synthesia公式サイト](https://synthesiagame.com/) は機能上の参考としています。技術参照：[Mido Standard MIDI Files](https://mido.readthedocs.io/en/stable/files/midi.html)、[TinySoundFont Python bindings](https://github.com/amberwhitehead/tinysoundfont-pybind)。依存ライブラリは各配布元のライセンスが適用されます。

楽譜には [Bravura](https://github.com/steinbergmedia/bravura) 音楽フォント（Steinberg、SIL Open Font License 1.1）を同梱しています。ライセンス全文は `static/fonts/LICENSE-Bravura.txt`。追加の楽譜ソフトのインストールは不要です。

## Browser-side realtime audio (v11)

Realtime preview no longer renders one WAV stem per MIDI part on the Python server.
The browser lazily loads the pinned `spessasynth_lib` 4.3.14 AudioWorklet engine,
fetches the selected SF2 once, and schedules MIDI channel events locally. This means:

- master volume, per-part volume and mute are applied immediately in the browser;
- program changes do not trigger server-side audio re-rendering;
- playback speed is implemented by MIDI event scheduling, so pitch does not change;
- the old `/api/stem` endpoint is retained only as a compatibility fallback and is not used by the UI;
- MP4/WAV export still uses Python + TinySoundFont + FFmpeg for deterministic output.

For this prototype, SpessaSynth's ESM bundle and AudioWorklet processor are loaded from
jsDelivr and pinned to the same version. Before a public deployment, bundle/self-host
these two assets and serve the default SoundFont from object storage/CDN. The remaining
server work for normal preview is MIDI search/download, MIDI parsing/score endpoints,
and serving the SF2 bytes; synthesis CPU is paid by the user's browser.
